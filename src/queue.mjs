import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import lockfile from 'proper-lockfile';

export const PROTOCOL_VERSION = 1;
export class BridgeError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temp, file);
  } finally {
    await handle?.close();
    await fs.rm(temp, { force: true });
  }
}
export async function readJson(file, optional = false) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new BridgeError('PROTOCOL_ERROR', `Cannot read ${path.basename(file)}: ${error.message}`);
  }
}
const safeId = /^[a-zA-Z0-9_-]{1,80}$/;
export function validateId(id) {
  if (!safeId.test(id)) throw new BridgeError('INVALID_REQUEST_ID', 'requestId must contain 1–80 letters, digits, hyphens or underscores.');
}
function sessionIsFresh(session, staleMs) {
  return session?.protocolVersion === PROTOCOL_VERSION && session.state === 'running'
    && Number.isFinite(session.heartbeatAt) && Date.now() - session.heartbeatAt <= staleMs
    && session.heartbeatAt <= Date.now() + 2000;
}
export class FileQueue {
  constructor(directory, { staleMs = 6000, pollMs = 20 } = {}) {
    this.directory = path.resolve(directory); this.staleMs = staleMs; this.pollMs = pollMs;
    this.indexFile = path.join(this.directory, 'queue.json');
  }
  file(kind, id) { validateId(id); return path.join(this.directory, kind, `${id}.json`); }
  async prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const kind of ['requests', 'replies', 'receipts', 'cancellations'])
      await fs.mkdir(path.join(this.directory, kind), { recursive: true, mode: 0o700 });
  }
  async status() {
    const session = await readJson(path.join(this.directory, 'session.json'), true);
    return { directory: this.directory, online: sessionIsFresh(session, this.staleMs), session,
      heartbeatAgeMs: session ? Date.now() - session.heartbeatAt : null };
  }
  async requireSession(expectedId) {
    const status = await this.status();
    if (!status.online) throw new BridgeError('BRIDGE_OFFLINE', 'Start SV Agent Bridge in the Studio Scripts menu; its heartbeat must be current.', status);
    if (expectedId && status.session.sessionId !== expectedId)
      throw new BridgeError('SESSION_CHANGED', 'The active bridge session changed; reread the project before editing.');
    return status.session;
  }
  async withLock(fn) {
    let compromised;
    const release = await lockfile.lock(this.directory, {
      lockfilePath: path.join(this.directory, 'publisher.lock'), stale: 10000, update: 1000,
      retries: { retries: 100, minTimeout: 10, maxTimeout: 50, factor: 1.1 },
      onCompromised: error => { compromised = error; },
    });
    try { return await fn(() => { if (compromised) throw new BridgeError('QUEUE_LOCK_LOST', compromised.message); }); }
    finally { await release(); }
  }
  async request(method, params = {}, options = {}) {
    const requestId = options.requestId ?? randomUUID();
    try { return await this.executeRequest(method, params, { ...options, requestId }); }
    catch (error) {
      if (error instanceof BridgeError) error.details = { ...error.details, requestId };
      throw error;
    }
  }
  async executeRequest(method, params, { requestId, sessionId, timeoutMs = 5000, signal }) {
    validateId(requestId);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 2000 || timeoutMs > 60000)
      throw new BridgeError('INVALID_TIMEOUT', 'timeoutMs must be 2000–60000.');
    if (signal?.aborted) throw new BridgeError('REQUEST_CANCELLED', 'Request cancelled before publication.', { mayHaveApplied: false });
    await this.prepare();
    const session = await this.requireSession(sessionId);
    const requestPath = this.file('requests', requestId);
    const replyPath = this.file('replies', requestId);
    const deadlineAt = Date.now() + timeoutMs;
    let request;
    await this.withLock(async checkLock => {
      await this.requireSession(session.sessionId);
      request = await readJson(requestPath, true);
      if (request) {
        if (request.sessionId !== session.sessionId || request.method !== method || JSON.stringify(request.params) !== JSON.stringify(params))
          throw new BridgeError('REQUEST_ID_CONFLICT', 'This requestId was already used for a different request or session.');
      } else {
        request = { protocolVersion: PROTOCOL_VERSION, id: requestId, sessionId: session.sessionId,
          projectFile: session.projectFile, method, params, createdAt: Date.now(), deadlineAt };
        if (Buffer.byteLength(JSON.stringify(request)) > 512 * 1024)
          throw new BridgeError('REQUEST_TOO_LARGE', 'Request exceeds 512 KiB; split large edits into smaller batches.', { mayHaveApplied: false });
        checkLock(); await atomicJson(requestPath, request);
      }
      const index = await readJson(this.indexFile, true) ?? { protocolVersion: PROTOCOL_VERSION, entries: [] };
      if (index.protocolVersion !== PROTOCOL_VERSION || !Array.isArray(index.entries))
        throw new BridgeError('PROTOCOL_ERROR', 'Invalid queue index.');
      // Only remove entries with a durable reply or from a different session. Never drop a timed-out mutation here.
      const retained = [];
      for (const item of index.entries) {
        validateId(item.id);
        if (item.sessionId === session.sessionId && !(await readJson(this.file('replies', item.id), true))) retained.push(item);
      }
      if (!retained.some(item => item.id === requestId) && !(await readJson(replyPath, true))) {
        if (retained.length >= 256) throw new BridgeError('QUEUE_FULL', 'At most 256 requests may be pending.');
        retained.push({ id: requestId, sessionId: session.sessionId });
      }
      checkLock(); await atomicJson(this.indexFile, { protocolVersion: PROTOCOL_VERSION, entries: retained });
    });
    while (true) {
      const reply = await readJson(replyPath, true);
      if (reply) {
        if (reply.protocolVersion !== PROTOCOL_VERSION || reply.id !== requestId || reply.sessionId !== session.sessionId || typeof reply.ok !== 'boolean')
          throw new BridgeError('REPLY_MISMATCH', 'Reply ID, session or protocol does not match the request.', { requestId });
        return reply;
      }
      if (signal?.aborted || Date.now() >= deadlineAt) {
        await atomicJson(this.file('cancellations', requestId), { id: requestId, sessionId: session.sessionId });
        throw new BridgeError(signal?.aborted ? 'REQUEST_CANCELLED' : 'REQUEST_TIMEOUT',
          'No reply received. Do not repeat an edit with a new ID: inspect/retry this requestId first.',
          { requestId, sessionId: session.sessionId, mayHaveApplied: true });
      }
      try { await this.requireSession(session.sessionId); }
      catch (error) {
        if (error instanceof BridgeError) error.details = { ...error.details, requestId, mayHaveApplied: true };
        throw error;
      }
      await sleep(this.pollMs);
    }
  }
  async result(requestId) {
    validateId(requestId);
    const request = await readJson(this.file('requests', requestId), true);
    const reply = await readJson(this.file('replies', requestId), true);
    if (reply && (!request || reply.id !== requestId || reply.sessionId !== request.sessionId || reply.protocolVersion !== PROTOCOL_VERSION))
      throw new BridgeError('REPLY_MISMATCH', 'Stored reply does not match its request.');
    return { requestId, request, reply, receipt: await readJson(this.file('receipts', requestId), true) };
  }
}
