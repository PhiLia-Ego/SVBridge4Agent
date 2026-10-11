import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AudioCapture} from '../src/audio.mjs';
import {BridgeError} from '../src/queue.mjs';
async function fixture(t,{silent=false,playbackFailure=false,invalidSamples=0,stopReason='command'}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sv-audio-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const events=[];
 let seconds=12,status='stopped',startCount=0,sid='session',finishNative;
 const stats={durationSeconds:1.2,frames:57600,sampleRate:48000,nonzeroSamples:silent?0:100,rms:silent?0:.1,droppedBuffers:0,invalidSamples,stopReason,peak:.2};
 const queue={directory,prepare:async()=>{},requireSession:async expected=>{if(expected!==sid)throw new BridgeError('SESSION_CHANGED','Session changed');return {projectFile:'/test.svp'};},request:async(method,p,options)=>{
  await queue.requireSession(options.sessionId);events.push(method==='sv_playback'?p.action:'read');
  if(method==='sv_get_playback'){if(status==='playing')seconds+=.6;return {ok:true,result:{seconds,status}};}
  if(p.action==='seek')seconds=p.seconds;if(p.action==='play'){status='playing';if(playbackFailure)throw new BridgeError('REQUEST_TIMEOUT','Play acknowledgement lost');}if(p.action==='stop')status='stopped';return {ok:true,result:{seconds,status}};
 }};
 const audio=new AudioCapture(queue,{wait:async()=>{},startCapture:async output=>{
  events.push('ready');startCount++;await fs.writeFile(output,'fake WAV for lifecycle test');
  const finished=new Promise(resolve=>{finishNative=()=>resolve(stats);});
  return {finished,stop:async()=>{events.push('capture-stop');finishNative();return stats;}};
 }});
 return {audio,events,input:{sessionId:'session',requestId:'take',startSeconds:20,durationSeconds:1,tailSeconds:0},state:()=>({seconds,status,startCount}),changeSession:()=>{sid='new';},endNative:()=>finishNative()};
}
test('Capture is ready before play, restores playhead, and retries never record twice',async t=>{
 const f=await fixture(t);const result=await f.audio.capture(f.input);assert.ok(f.events.indexOf('ready')<f.events.indexOf('play'));assert.deepEqual(f.state(),{seconds:12,status:'stopped',startCount:1});
 assert.deepEqual(await f.audio.capture(f.input),result);assert.equal(f.state().startCount,1);
 await assert.rejects(f.audio.capture({...f.input,durationSeconds:2}),e=>e.code==='REQUEST_ID_CONFLICT');assert.equal((await f.audio.result('take')).state,'completed');
});
test('Lost play acknowledgement stops playback and fails durably',async t=>{
 const f=await fixture(t,{playbackFailure:true});await assert.rejects(f.audio.capture(f.input),e=>e.code==='REQUEST_TIMEOUT');assert.equal(f.state().status,'stopped');assert.equal(f.state().seconds,12);assert.ok(f.events.includes('capture-stop'));assert.equal((await f.audio.result('take')).state,'failed');
 await assert.rejects(f.audio.capture(f.input),e=>e.code==='AUDIO_PREVIOUSLY_FAILED');assert.equal(f.state().startCount,1);
});
test('Silent capture is a failure and never reported as a rendered take',async t=>{
 const f=await fixture(t,{silent:true});await assert.rejects(f.audio.capture(f.input),e=>e.code==='AUDIO_SILENT');assert.equal((await f.audio.result('take')).state,'failed');assert.equal(f.state().status,'stopped');
});
test('Already cancelled capture starts neither playback nor recording',async t=>{
 const f=await fixture(t);await assert.rejects(f.audio.capture(f.input,{signal:AbortSignal.abort()}),e=>e.code==='REQUEST_CANCELLED');assert.equal(f.state().startCount,0);assert.ok(!f.events.includes('play'));assert.equal(await f.audio.result('take'),null);
});
test('Cancellation during playback closes capture and restores the original position',async t=>{
 const f=await fixture(t);const controller=new AbortController();f.audio.wait=async()=>{controller.abort();};
 await assert.rejects(f.audio.capture(f.input,{signal:controller.signal}),e=>e.code==='REQUEST_CANCELLED');assert.deepEqual(f.state(),{seconds:12,status:'stopped',startCount:1});assert.ok(f.events.includes('capture-stop'));assert.equal((await f.audio.result('take')).state,'failed');
});
test('A changed session prevents cleanup from controlling the newly opened project',async t=>{
 const f=await fixture(t);f.audio.wait=async()=>f.changeSession();
 await assert.rejects(f.audio.capture(f.input),e=>e.code==='SESSION_CHANGED'&&e.details.cleanupErrors.length>0);assert.ok(f.events.includes('capture-stop'));assert.ok(!f.events.includes('stop'),'Cleanup controlled the new session');assert.equal((await f.audio.result('take')).state,'failed');
});
test('An unfinished durable receipt prevents a crash retry from replaying audio',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.audio.queue.directory,'recordings'),{recursive:true});
 await fs.writeFile(path.join(f.audio.queue.directory,'recordings/take.json'),JSON.stringify({state:'executing',params:f.input}));
 await assert.rejects(f.audio.capture(f.input),e=>e.code==='AUDIO_INDETERMINATE');assert.equal(f.state().startCount,0);assert.equal((await f.audio.result('take')).state,'executing');
});

test('Early helper completion cannot appear successful even with sufficient recorded frames',async t=>{
 const f=await fixture(t);f.audio.wait=async()=>f.endNative();
 await assert.rejects(f.audio.capture(f.input),e=>e.code==='AUDIO_EARLY_STOP');
 assert.deepEqual(f.state(),{seconds:12,status:'stopped',startCount:1});assert.equal((await f.audio.result('take')).state,'failed');
});
test('Helper completion during the requested tail is still an incomplete take',async t=>{
 const f=await fixture(t);let waits=0;f.audio.wait=async()=>{if(++waits===3)f.endNative();};
 await assert.rejects(f.audio.capture({...f.input,tailSeconds:.3}),e=>e.code==='AUDIO_EARLY_STOP');
 assert.equal((await f.audio.result('take')).state,'failed');assert.equal(f.state().seconds,12);
});
test('Nonfinite PCM samples invalidate the recording',async t=>{
 const f=await fixture(t,{invalidSamples:1});await assert.rejects(f.audio.capture(f.input),e=>e.code==='AUDIO_INCOMPLETE');
 assert.equal((await f.audio.result('take')).state,'failed');assert.equal(f.state().status,'stopped');
});

test('A native timeout racing with the stop command cannot be reported as a completed take',async t=>{
 const f=await fixture(t,{stopReason:'timeout'});await assert.rejects(f.audio.capture(f.input),e=>e.code==='AUDIO_INCOMPLETE');
 assert.equal((await f.audio.result('take')).state,'failed');assert.equal(f.state().status,'stopped');
});
