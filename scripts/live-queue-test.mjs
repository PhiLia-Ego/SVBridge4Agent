// Edits only agent_queue_test.svp, then restores the captured live state.
import assert from 'node:assert/strict';
import path from 'node:path';
import { capabilities } from '../src/tools.mjs';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root=path.resolve(import.meta.dirname,'..');
const output=path.join(root,'test_results/atomic-queue');await fs.mkdir(output,{recursive:true});
const client=new Client({name:'sv-agent-live-test',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/cli.mjs')],stderr:'pipe'});
const log=[];
let sessionId,groupUuid,baseline,points,track,summary;
async function raw(name,args={}) {
  const started=performance.now();
  const result=await client.callTool({name,arguments:{...args,...(sessionId?{sessionId}:{})}});
  let parsed;try{parsed=JSON.parse(result.content[0].text);}catch{parsed={text:result.content[0].text};}
  log.push({name,args,isError:result.isError??false,elapsedMs:Math.round(performance.now()-started),response:parsed});
  await fs.writeFile(path.join(output,'live-log.json'),JSON.stringify(log,null,2));
  return {result,parsed};
}
async function call(name,args={}) {
  const {result,parsed}=await raw(name,args);
  assert.ok(!result.isError,JSON.stringify(parsed));return parsed.result??parsed;
}
async function notes(){return call('sv_get_notes',{groupUuid,count:2000});}
try {
  await client.connect(transport);
  const tools=await client.listTools();assert.equal(tools.tools.length,capabilities().tools.length);await fs.writeFile(path.join(output,'tools.json'),JSON.stringify(tools,null,2));
  const status=await call('sv_status');assert.equal(status.online,true);
  assert.equal(status.session.projectFile,path.join(root,'test_proj/agent_queue_test.svp'));
  sessionId=status.session.sessionId;
  summary=await call('sv_get_project_summary');assert.equal(summary.noteCount,1197);assert.equal(summary.tracks.length,3);
  const snapshot=await call('sv_read_project');await fs.writeFile(path.join(output,'before.json'),JSON.stringify(snapshot,null,2));
  const original=JSON.parse((await fs.readFile(path.join(root,'test_proj/og.svp'),'utf8')).replace(/\0+$/,''));
  let compared=0;
  const originalGroups=new Map(original.library.map(g=>[g.uuid,g]));
  for(const [uuid,actual] of Object.entries(snapshot.groups)) {
    if(actual.notes.length===0) continue;
    const g=originalGroups.get(uuid);assert.ok(g);
    assert.equal(actual.notes.length,g.notes.length);
    for(let i=0;i<g.notes.length;i++) {
      for(const key of ['pitch','onset','duration','lyrics','phonemes']) assert.equal(actual.notes[i][key]??'',g.notes[i][key]??'');
      compared++;
    }
  }
  assert.equal(compared,summary.libraryNoteCount);
  const fileOnlyGroups=original.library.filter(g=>!snapshot.groups[g.uuid]).map(g=>({groupUuid:g.uuid,noteCount:g.notes.length}));
  await fs.writeFile(path.join(output,'file-only-groups.json'),JSON.stringify(fileOnlyGroups,null,2));
  track=summary.tracks[1];groupUuid=track.groups.find(g=>!g.isMain).groupUuid;
  baseline=await notes();points=(await call('sv_get_parameter_points',{groupUuid,parameter:'tension'})).points;
  const selected=await call('sv_get_selected_notes');assert.ok(Array.isArray(selected.notes));
  const requestId=randomUUID();
  const edit={groupUuid,expectedRevision:baseline.revision,updates:[{index:1,set:{pitch:baseline.notes[0].pitch+2,lyrics:'测试🎵'}}],requestId};
  const edited=await call('sv_update_notes',edit);
  assert.deepEqual(await call('sv_update_notes',edit),edited,'Retry changed the reply');
  const changed=await notes();assert.equal(changed.notes[0].pitch,baseline.notes[0].pitch+2);assert.equal(changed.notes[0].lyrics,'测试🎵');
  const stale=await raw('sv_update_notes',{groupUuid,expectedRevision:baseline.revision,updates:[{index:1,set:{pitch:60}}]});
  assert.equal(stale.parsed.error.code,'REVISION_CONFLICT');
  const conflict=await raw('sv_update_notes',{...edit,updates:[{index:1,set:{pitch:60}}]});assert.equal(conflict.parsed.error.code,'REQUEST_ID_CONFLICT');
  await call('sv_set_parameter_points',{groupUuid,expectedRevision:changed.revision,parameter:'tension',points:[[baseline.notes[0].onset,.25]],mode:'replace'});
  const parameter=await call('sv_get_parameter_points',{groupUuid,parameter:'tension'});assert.equal(parameter.points[0][1],.25);
  const onset=Math.max(...baseline.notes.map(n=>n.onset+n.duration))+705600000;
  await call('sv_add_notes',{groupUuid,expectedRevision:parameter.revision,notes:[{onset,duration:705600000,pitch:60,lyrics:'新增'}]});
  const added=await notes();assert.equal(added.total,baseline.total+1);
  const newNote=added.notes.find(n=>n.onset===onset);assert.ok(newNote);
  await call('sv_delete_notes',{groupUuid,expectedRevision:added.revision,indices:[newNote.index]});assert.equal((await notes()).total,baseline.total);
  await call('sv_rename_track',{trackIndex:track.index,trackUuid:track.trackUuid,expectedName:track.name,name:'原子队列实测'});
  await call('sv_playback',{action:'seek',seconds:15});assert.equal((await call('sv_playback',{action:'play'})).status,'playing');
  await call('sv_playback',{action:'stop'});await call('sv_playback',{action:'seek',seconds:summary.playback.seconds});
  const simultaneous=await Promise.all(Array.from({length:12},()=>call('sv_get_project_summary')));
  assert.ok(simultaneous.every(x=>x.noteCount===1197 && x.tracks[1].name==='原子队列实测'));
  await fs.writeFile(path.join(output,'edited.json'),JSON.stringify(await call('sv_read_project'),null,2));
  console.log(`Live checks passed: ${compared} library notes matched (1197 referenced); update/retry/conflict, add/delete, parameters, track, playback and 12 parallel calls.`);
} finally {
  if(baseline) {
    const current=await notes();
    const original=baseline.notes[0];
    await call('sv_update_notes',{groupUuid,expectedRevision:current.revision,updates:[{index:1,set:{pitch:original.pitch,lyrics:original.lyrics,phonemes:original.phonemes}}]});
    await call('sv_set_parameter_points',{groupUuid,expectedRevision:(await notes()).revision,parameter:'tension',mode:'replace',points});
    const currentSummary=await call('sv_get_project_summary');const currentTrack=currentSummary.tracks[track.index-1];
    if(currentTrack.name!==track.name) await call('sv_rename_track',{trackIndex:track.index,trackUuid:track.trackUuid,expectedName:currentTrack.name,name:track.name});
    await call('sv_playback',{action:'stop'});await call('sv_playback',{action:'seek',seconds:summary.playback.seconds});
    const restored=await notes();assert.deepEqual(restored,baseline);
    const snapshot=await call('sv_read_project');const before=JSON.parse(await fs.readFile(path.join(output,'before.json'),'utf8'));
    assert.deepEqual(snapshot,before,'Live project was not fully restored');
    await fs.writeFile(path.join(output,'restored.json'),JSON.stringify(snapshot,null,2));
    await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({sessionId,projectFile:summary.projectFile,referencedNotes:1197,libraryNotesCompared:summary.libraryNoteCount,tools:capabilities().tools.length,calls:log.length,restored:true,latencyMs:log.map(x=>x.elapsedMs)},null,2));
    console.log('Live snapshot restored exactly to the captured baseline.');
  }
  await client.close();
}
