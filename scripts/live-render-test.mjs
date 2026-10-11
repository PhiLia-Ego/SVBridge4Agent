// Verify the note edit -> actual synthesis/playback -> process capture loop on the test copy.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'test_results/macos');
const c=new Client({name:'sv-real-render-test',version:'1'});let sid,singer,baseline,notes,ref,edited=false;const calls=[];
async function call(name,args={}){const response=await c.callTool({name,arguments:{...args,...(sid?{sessionId:sid}:{})}},undefined,{timeout:180000});const r=JSON.parse(response.content[0].text);calls.push({name,args,response:r});await fs.writeFile(path.join(dir,'render-log.json'),JSON.stringify(calls,null,2));assert.ok(!response.isError,JSON.stringify(r));return r.ok===true?r.result:r;}
async function structure(){return call('sv_get_project_structure');}
async function mixer(set){return call('sv_set_track_mixer',{expectedProjectRevision:(await structure()).revision,trackIndex:singer.index,trackUuid:singer.trackUuid,set});}
async function readNotes(){return call('sv_get_notes',{groupUuid:ref.groupUuid,count:2000});}
try{
 await fs.mkdir(dir,{recursive:true});await c.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/cli.mjs')],stderr:'pipe'}));
 const status=await call('sv_status');assert.equal(status.session.projectFile,path.join(root,'test_proj/agent_queue_test.svp'));sid=status.session.sessionId;
 baseline=await structure();singer=baseline.tracks[1];ref=singer.groups.find(g=>g.noteCount>0);notes=await readNotes();
 await mixer({solo:true});
 // Transpose every note in the first phrase so that the captured interval includes regenerated audio.
 const updates=notes.notes.map(n=>({index:n.index,set:{pitch:n.pitch+2}}));edited=true;
 await call('sv_update_notes',{groupUuid:ref.groupUuid,expectedRevision:notes.revision,requestId:randomUUID(),updates});
 const changed=await readNotes();assert.ok(changed.notes.every((n,i)=>n.pitch===notes.notes[i].pitch+2));
 const recording=await call('sv_capture_audio',{requestId:'transposed-'+randomUUID(),startSeconds:15,durationSeconds:8,tailSeconds:.3});
 assert.ok(recording.rms>.00001);assert.equal(recording.droppedBuffers,0);
 await fs.copyFile(recording.output,path.join(dir,'transposed-vocal.wav'));await fs.writeFile(path.join(dir,'transposed-recording.json'),JSON.stringify(recording,null,2));
 console.log('Regenerated and captured the first phrase transposed by two semitones.');console.log(JSON.stringify(recording,null,2));
}finally{
 if(edited){const current=await readNotes();await call('sv_update_notes',{groupUuid:ref.groupUuid,expectedRevision:current.revision,updates:notes.notes.map(n=>({index:n.index,set:{pitch:n.pitch}}))});assert.deepEqual(await readNotes(),notes);}
 if(singer)await mixer(singer.mixer);
 if(baseline){assert.deepEqual(await structure(),baseline);console.log('Notes, curves, project structure, mixer and voice state restored.');}
 await c.close();
}
