#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.mjs';
import { FileQueue } from './queue.mjs';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
if (dirIndex !== -1 && !args[dirIndex + 1]) throw new Error('--dir requires a path');
const directory = path.resolve(dirIndex === -1 ? process.env.SV_AGENT_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../.sv-agent') : args[dirIndex + 1]);
if (args.includes('--status')) {
  console.log(JSON.stringify(await new FileQueue(directory).status(), null, 2));
} else {
  await new FileQueue(directory).prepare();
  await createServer(directory).connect(new StdioServerTransport());
}
