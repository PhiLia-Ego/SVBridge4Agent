import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const client=new Client({name:'sv-agent-cli-client',version:'0.1.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/cli.mjs')],stderr:'pipe'});
try {
  await client.connect(transport);
  const name=process.argv[2]??'sv_status';
  const result=name==='list' ? await client.listTools() : await client.callTool({name,arguments:JSON.parse(process.argv[3]??'{}')},undefined,{timeout:180000});
  console.log(JSON.stringify(result,null,2));
  if(result.isError) process.exitCode=1;
} finally { await client.close(); }
