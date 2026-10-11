// Run only on the disposable test copy. Restore all original project state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'test_results/macos');await fs.mkdir(dir,{recursive:true});
const tempoPosition=705600000*1024,meterMeasure=1024;
const client=new Client({name:'sv-live-extended',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/cli.mjs')],stderr:'pipe'});
let sid,track,group,baseline,playback;const log=[];
async function raw(name,args={}){const r=await client.callTool({name,arguments:{...args,...(sid?{sessionId:sid}:{})}},undefined,{timeout:180000});let data;try{data=JSON.parse(r.content[0].text);}catch{data={ok:false,error:{code:'MCP_VALIDATION',message:r.content[0].text}};}log.push({name,args,data});await fs.writeFile(path.join(dir,'extended-log.json'),JSON.stringify(log,null,2));return data;}
async function call(name,args={}){const r=await raw(name,args);assert.notEqual(r.ok,false,JSON.stringify(r));return r.ok===true?r.result:r;}
async function struct(){return call('sv_get_project_structure');}
async function edit(name,args){const s=await struct();return call(name,{expectedProjectRevision:s.revision,...args});}
function tr(){return {trackIndex:track.trackIndex,trackUuid:track.trackUuid};}
try {
 await client.connect(transport);const status=await call('sv_status');assert.equal(status.online,true);assert.equal(status.session.projectFile,path.join(root,'test_proj/agent_queue_test.svp'));sid=status.session.sessionId;
 baseline=await struct();playback=await call('sv_get_playback');await fs.writeFile(path.join(dir,'before-extended.json'),JSON.stringify(baseline,null,2));
 track=await edit('sv_create_track',{name:'Agent disposable API test'});assert.equal((await struct()).tracks.length,baseline.tracks.length+1);
 group=await edit('sv_create_note_group',{name:'Agent disposable group'});
 const stale=await raw('sv_create_note_group',{expectedProjectRevision:baseline.revision,name:'must reject'});assert.equal(stale.error.code,'PROJECT_REVISION_CONFLICT');
 await edit('sv_rename_note_group',{groupUuid:group.groupUuid,name:'Agent renamed group'});
 const attached=await edit('sv_attach_note_group',{...tr(),groupUuid:group.groupUuid,timeOffset:705600000,pitchOffset:2});
 const ref={...tr(),groupUuid:group.groupUuid,referenceIndex:attached.referenceIndex};
 await edit('sv_set_group_reference',{...ref,set:{timeOffset:1411200000,pitchOffset:-2,muted:true}});
 let current=await struct();let r=current.tracks.at(-1).groups.find(r=>r.groupUuid===group.groupUuid);assert.equal(r.timeOffset,1411200000);assert.equal(r.pitchOffset,-2);assert.equal(r.muted,true);
 await edit('sv_set_track_mixer',{...tr(),set:{gainDecibel:-6,pan:.25,muted:true,solo:false}});assert.equal((await struct()).tracks.at(-1).mixer.pan,.25);
 await edit('sv_set_voice_attributes',{...ref,attributes:{paramLoudness:-3,paramTension:.2,paramBreathiness:.1,paramGender:-.1,paramToneShift:20}});
 current=await struct();r=current.tracks.at(-1).groups.find(r=>r.groupUuid===group.groupUuid);await fs.writeFile(path.join(dir,'voice-readback.json'),JSON.stringify(r.voice,null,2));assert.ok(Math.abs(r.voice.paramTension-.2)<1e-6);
 await edit('sv_set_voice_attributes',{...ref,attributes:{vocalModeParams:{Soft:{pitch:100,timbre:80,pronunciation:60}}}});
 current=await struct();r=current.tracks.at(-1).groups.find(r=>r.groupUuid===group.groupUuid);assert.equal(r.voice.vocalModeParams.Soft.pitch,100);
 const invalid=await raw('sv_set_voice_attributes',{...ref,expectedProjectRevision:current.revision,attributes:{vocalModeParams:{Soft:{pitch:151}}}});assert.equal(invalid.error.code,'MCP_VALIDATION');
 const referenced=await raw('sv_remove_note_group',{groupUuid:group.groupUuid,expectedProjectRevision:current.revision});assert.equal(referenced.error.code,'INVALID_ARGUMENT');
 const origin=await raw('sv_set_time_axis',{expectedProjectRevision:current.revision,tempo:[{position:0,remove:true}]});assert.equal(origin.ok,false);
 const main=current.tracks.at(-1).groups.find(r=>r.isMain);const mainFail=await raw('sv_detach_note_group',{...tr(),referenceIndex:main.referenceIndex,groupUuid:main.groupUuid,expectedProjectRevision:current.revision});assert.equal(mainFail.error.code,'INVALID_ARGUMENT');
 // Use far-away new marks to avoid replacing a baseline marker.
 assert.ok(!baseline.tempo.some(m=>m.position===tempoPosition));assert.ok(!baseline.meter.some(m=>m.position===meterMeasure));
 await edit('sv_set_time_axis',{tempo:[{position:tempoPosition,bpm:123}],meter:[{measure:meterMeasure,numerator:3,denominator:4}]});
 current=await struct();assert.equal(current.tempo.find(m=>m.position===tempoPosition).bpm,123);assert.equal(current.meter.find(m=>m.position===meterMeasure).numerator,3);
 await edit('sv_set_time_axis',{tempo:[{position:tempoPosition,remove:true}],meter:[{measure:meterMeasure,remove:true}]});
 await edit('sv_detach_note_group',ref);await edit('sv_remove_note_group',{groupUuid:group.groupUuid});group=null;
 await edit('sv_remove_track',tr());track=null;assert.deepEqual(await struct(),baseline);
 const audio=await call('sv_audio_status');assert.equal(audio.processCount,1);assert.equal(audio.built,true);
 // Solo the existing vocal track, excluding the accompaniment and other singer.
 const singer=baseline.tracks[1];await edit('sv_set_track_mixer',{trackIndex:singer.index,trackUuid:singer.trackUuid,set:{solo:true}});
 try{
  const request={requestId:'real-vocal-'+randomUUID(),startSeconds:15,durationSeconds:8,tailSeconds:.3};
  const recorded=await call('sv_capture_audio',request);assert.equal(recorded.droppedBuffers,0);assert.ok(recorded.rms>.00001);assert.ok(recorded.frames>0);
  assert.deepEqual(await call('sv_capture_audio',request),recorded,'Capture retry must return the original take');
  const receipt=await call('sv_get_audio_result',{requestId:request.requestId});assert.equal(receipt.state,'completed');
  const conflict=await raw('sv_capture_audio',{...request,durationSeconds:9});assert.equal(conflict.error.code,'REQUEST_ID_CONFLICT');
  await fs.copyFile(recorded.output,path.join(dir,'real-vocal.wav'));await fs.writeFile(path.join(dir,'recording.json'),JSON.stringify(recorded,null,2));
  assert.deepEqual(await call('sv_get_playback'),playback);console.log(JSON.stringify(recorded,null,2));
 }finally{await edit('sv_set_track_mixer',{trackIndex:singer.index,trackUuid:singer.trackUuid,set:singer.mixer});}
 assert.deepEqual(await struct(),baseline);console.log('All extended operations and real audio capture passed; baseline restored.');
}finally{
 if(baseline){const current=await struct();const tempo=current.tempo.some(m=>m.position===tempoPosition)&&!baseline.tempo.some(m=>m.position===tempoPosition)?[{position:tempoPosition,remove:true}]:[];const meter=current.meter.some(m=>m.position===meterMeasure)&&!baseline.meter.some(m=>m.position===meterMeasure)?[{measure:meterMeasure,remove:true}]:[];if(tempo.length+meter.length)await edit('sv_set_time_axis',{tempo,meter});}
 if(group&&track){const s=await struct();const t=s.tracks.find(t=>t.trackUuid===track.trackUuid);const ref=t?.groups.find(g=>g.groupUuid===group.groupUuid);if(ref)await edit('sv_detach_note_group',{...tr(),referenceIndex:ref.referenceIndex,groupUuid:group.groupUuid});await edit('sv_remove_note_group',{groupUuid:group.groupUuid});}
 if(track)await edit('sv_remove_track',tr());
 await client.close();
}
