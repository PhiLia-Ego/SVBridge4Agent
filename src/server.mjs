import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { FileQueue, BridgeError } from './queue.mjs';
import { toolDefinitions, requestOptions, capabilities, audioSchema } from './tools.mjs';
import { AudioCapture, audioStatus } from './audio.mjs';

function result(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}
export function failure(error) {
  return result({ ok: false, error: { code: error instanceof BridgeError ? error.code : 'INTERNAL_ERROR', message: error.message,
    ...(error instanceof BridgeError ? error.details : {}) } }, true);
}
export function createServer(directory) {
  const queue = new FileQueue(directory);
  const audio = new AudioCapture(queue);
  const server = new McpServer({ name: 'sv-studio-agent', version: '0.1.0' }, {
    instructions: 'Tools access the live Synthesizer V project via an atomic file queue. Call sv_status and read the target group first. Pin sessionId on writes, use the returned expectedRevision, and use a stable requestId for retries. Never repeat a timed-out edit with a fresh ID. Note time is in blicks; playback seek is in seconds. Track/note indices are 1-based. Group edits affect all references to that UUID.',
  });
  const registerLocal = (name, description, inputSchema, fn) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async input => { try { return result(await fn(input)); } catch (error) { return failure(error); } });
  registerLocal('sv_status','Inspect the bridge session, project path and heartbeat; works even if Studio is offline.', {}, () => queue.status());
  registerLocal('sv_capabilities','Describe supported interfaces and units without requiring Studio.', {}, async () => ({ ...capabilities(), ...await queue.status() }));
  registerLocal('sv_get_request_result','Inspect a saved request/reply/receipt after timeout; does not execute it again.', {
    requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  }, input => queue.result(input.requestId));
  registerLocal('sv_audio_status','Probe the macOS audio helper and SV2 process availability; does not record.', {}, () => audioStatus());
  registerLocal('sv_get_audio_result','Inspect a durable audio capture result without executing playback again.', {requestId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)}, input => audio.result(input.requestId));
  server.registerTool('sv_capture_audio', {
    description:'Record SV2 Pro playback to a local WAV using a macOS 14.2+ process tap. Requires stopped playback and system audio recording permission. Takes real time; includes all audible SV2 tracks. Stable requestId prevents replay; inspect sv_get_audio_result after interruption.',
    inputSchema:audioSchema.shape,annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false},
  }, async(input,extra)=>{try{return result(await audio.capture(input,{signal:extra.signal}));}catch(error){return failure(error);}});
  for (const [name, definition] of Object.entries(toolDefinitions)) {
    server.registerTool(name, {
      description: definition.description,
      inputSchema: { ...definition.schema.shape, ...requestOptions,
        ...(!definition.readOnly ? { sessionId: z.string().min(1).max(80).describe('Required: sessionId from sv_status. Pins the project being edited or controlled.') } : {}),
      },
      annotations: { readOnlyHint: definition.readOnly === true, destructiveHint: !definition.readOnly, openWorldHint: false },
    }, async (input, extra) => {
      try {
        const { requestId, sessionId, timeoutMs, ...params } = input;
        const parsed = definition.schema.parse(params);
        const reply = await queue.request(name, parsed, { requestId, sessionId, timeoutMs, signal: extra.signal });
        return result(reply, !reply.ok);
      } catch (error) { return failure(error); }
    });
  }
  return server;
}
