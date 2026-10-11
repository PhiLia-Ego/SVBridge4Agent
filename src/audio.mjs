import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { BridgeError, atomicJson, readJson, validateId } from './queue.mjs';
import { audioSchema } from './tools.mjs';

export const helperPath=path.resolve(import.meta.dirname,'../.build/macos/SVAudioCapture.app/Contents/MacOS/SVAudioCapture');
const error=(code,message,details={})=>new BridgeError(code,message,details);
export async function audioStatus() {
  if(process.platform!=='darwin') return {supported:false,reason:'macOS 14.2+ is required'};
  try { await fs.access(helperPath); } catch { return {supported:true,built:false,buildCommand:'npm run build-audio'}; }
  const child=spawn(helperPath,['--probe'],{stdio:['ignore','pipe','pipe']});
  let output='',stderr=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(code!==0) throw error('AUDIO_PROBE_FAILED',stderr||output);
  return {...JSON.parse(output),built:true,helperPath,permission:'System audio recording authorization is checked when capture starts. A sandbox may hide process objects.'};
}
export async function startNativeCapture(output,maximumSeconds,{readyTimeoutMs=30000,signal}={}) {
  if(process.platform!=='darwin')throw error('AUDIO_UNSUPPORTED','Audio capture requires macOS 14.2+.');
  if(signal?.aborted)throw error('REQUEST_CANCELLED','Audio capture cancelled before starting the helper.');
  try { await fs.access(helperPath); } catch { throw error('AUDIO_HELPER_MISSING','Run npm run build-audio before recording.'); }
  const child=spawn(helperPath,['--record',output,String(maximumSeconds)],{stdio:['pipe','pipe','pipe']});
  let stderr='',readyEvent,completeEvent,settled=false;
  const lines=createInterface({input:child.stdout});
  let readyResolve,readyReject,finishResolve,finishReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const finished=new Promise((resolve,reject)=>{finishResolve=resolve;finishReject=reject;});
  // finished can reject while the caller is still awaiting the permission/ready event.
  finished.catch(()=>{});
  const timer=setTimeout(()=>{readyReject(error('AUDIO_READY_TIMEOUT','Capture did not become ready. Check the system audio recording permission.'));child.kill('SIGTERM');},readyTimeoutMs);
  child.stderr.on('data',b=>stderr=(stderr+b).slice(-4096));
  const fail=e=>{clearTimeout(timer);readyReject(e);if(!settled){settled=true;finishReject(e);}};
  const abort=()=>{fail(error('REQUEST_CANCELLED','Audio capture cancelled during helper initialization.'));child.kill('SIGTERM');};
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  child.once('error',e=>fail(error('AUDIO_HELPER_FAILED',e.message)));
  lines.on('line',line=>{
    try {
      const event=JSON.parse(line);
      if(event.event==='ready'){readyEvent=event;clearTimeout(timer);signal?.removeEventListener('abort',abort);readyResolve(event);}
      if(event.event==='complete')completeEvent=event;
      if(event.event==='error')fail(error('AUDIO_HELPER_FAILED',event.message));
    } catch { fail(error('AUDIO_PROTOCOL_ERROR','Malformed audio helper event'));child.kill('SIGTERM'); }
  });
  child.once('close',code=>{
    clearTimeout(timer);lines.close();signal?.removeEventListener('abort',abort);
    if(!settled){settled=true;if(code===0&&readyEvent&&completeEvent)finishResolve(completeEvent);else {const e=error('AUDIO_HELPER_FAILED',stderr||`Helper exited with code ${code} without a complete recording`);readyReject(e);finishReject(e);}}
  });
  // On pipe failure the child may already have exited; its close event reports the result.
  child.stdin.on('error',()=>{});
  try { const info=await ready;return {info,finished,stop(){child.stdin.end('stop\n');return finished;}}; }
  catch(e){child.kill('SIGTERM');throw e;}
}

export class AudioCapture {
  constructor(queue,{startCapture=startNativeCapture,wait=sleep}={}){this.queue=queue;this.startCapture=startCapture;this.wait=wait;}
  async result(requestId){validateId(requestId);return readJson(path.join(this.queue.directory,'recordings',`${requestId}.json`),true);}
  async capture(input,{signal}={}) {
    const params=audioSchema.parse(input); const {requestId,sessionId,startSeconds,durationSeconds,tailSeconds}=params;
    await this.queue.prepare();const directory=path.join(this.queue.directory,'recordings');await fs.mkdir(directory,{recursive:true,mode:0o700});
    let compromised=false,release;
    try {release=await lockfile.lock(directory,{lockfilePath:path.join(directory,'capture.lock'),stale:10000,update:1000,retries:0,onCompromised:()=>{compromised=true;}});}
    catch(e){throw error('AUDIO_CAPTURE_BUSY','Another capture is active. Inspect its result before retrying.');}
    const journal=path.join(directory,`${requestId}.json`), output=path.join(directory,`${requestId}.wav`);
    let recorder,oldPlayback,mayHavePlayed=false,recordingStopped=false,receipt;
    let nativeEnded=false,nativeError,nativeStopRequested=false;
    const check=()=>{
      if(signal?.aborted)throw error('REQUEST_CANCELLED','Audio capture cancelled');
      if(compromised)throw error('AUDIO_LOCK_LOST','Capture lock was lost');
      if(nativeEnded&&!nativeStopRequested)throw nativeError??error('AUDIO_EARLY_STOP','Capture helper ended before the requested recording was complete.');
    };
    const call=async(method,p={},cleanup=false)=>{
      if(!cleanup)check();
      const response=await this.queue.request(method,p,{sessionId,...(!cleanup?{signal}:{})});
      if(!response.ok)throw error(response.error.code,response.error.message,response.error);return response.result;
    };
    const cleanupPlayback=async()=>{
      if(!mayHavePlayed)return;
      await call('sv_playback',{action:'stop'},true);
      await call('sv_playback',{action:'seek',seconds:oldPlayback.seconds},true);
      mayHavePlayed=false;
    };
    try {
      receipt=await readJson(journal,true);
      if(receipt) {
        if(JSON.stringify(receipt.params)!==JSON.stringify(params))throw error('REQUEST_ID_CONFLICT','Audio requestId was already used for different parameters/session.');
        if(receipt.state==='completed')return receipt.result;
        throw error(receipt.state==='executing'?'AUDIO_INDETERMINATE':'AUDIO_PREVIOUSLY_FAILED','This capture ID will not execute again. Inspect sv_get_audio_result.',{receipt});
      }
      check();const session=await this.queue.requireSession(sessionId);
      oldPlayback=await call('sv_get_playback');
      if(oldPlayback.status!=='stopped')throw error('PLAYBACK_BUSY','Stop Studio playback before capturing.');
      // A stable ID is durable before capture or playback begins. Never overwrite an orphan WAV.
      const reservation=await fs.open(output,'wx',0o600);await reservation.close();
      receipt={state:'executing',params,projectFile:session.projectFile,startedAt:Date.now(),output};await atomicJson(journal,receipt);
      recorder=await this.startCapture(output,durationSeconds+tailSeconds+10,{signal});
      recorder.finished?.then(()=>{nativeEnded=true;},e=>{nativeEnded=true;nativeError=e;});
      check();
      const nativeStartedAt=Date.now();
      mayHavePlayed=true;await call('sv_playback',{action:'seek',seconds:startSeconds});
      await call('sv_playback',{action:'play'});const playbackAcknowledgedAt=Date.now();
      let elapsed=0,lastSeconds=startSeconds;
      while(elapsed<durationSeconds) {
        await this.wait(Math.min(250,(durationSeconds-elapsed)*1000),undefined,{signal});check();
        const pb=await call('sv_get_playback');
        if(pb.status!=='playing')throw error('PLAYBACK_INTERRUPTED','Studio playback stopped during recording.');
        if(pb.seconds+0.05<lastSeconds)throw error('PLAYBACK_LOOPED','Playhead moved backwards. Disable loop playback before recording.');
        lastSeconds=pb.seconds;elapsed=pb.seconds-startSeconds;
        if(Date.now()-playbackAcknowledgedAt>(durationSeconds+3)*1000)throw error('PLAYBACK_STALLED','Playhead failed to advance to the requested end.');
      }
      await call('sv_playback',{action:'stop'},true);
      if(tailSeconds>0)await this.wait(tailSeconds*1000,undefined,{signal});
      check();nativeStopRequested=true;
      const stats=await recorder.stop();recordingStopped=true;
      await cleanupPlayback();check();
      if(stats.error||stats.stopReason!=='command'||stats.droppedBuffers>0||(stats.invalidSamples??0)>0||!Number.isFinite(stats.durationSeconds)||stats.durationSeconds<durationSeconds-0.1)
        throw error('AUDIO_INCOMPLETE','Audio helper returned an incomplete recording.',{stats});
      if(!(stats.nonzeroSamples>0&&stats.rms>0.000001))throw error('AUDIO_SILENT','The recording contains no usable signal. Check system audio recording permission, voice assignment and mixer.',{stats});
      const result={requestId,sessionId,projectFile:session.projectFile,output,startSeconds,requestedDurationSeconds:durationSeconds,tailSeconds,
        playbackAcknowledgedOffsetSeconds:(playbackAcknowledgedAt-nativeStartedAt)/1000,...stats,
        timing:'Realtime recording includes capture lead-in, IPC scheduling and a stopped-playback tail; not sample-aligned offline export.'};
      await atomicJson(journal,{...receipt,state:'completed',completedAt:Date.now(),result});return result;
    } catch(e) {
      const cleanupErrors=[];
      try{await cleanupPlayback();}catch(cleanupError){cleanupErrors.push(cleanupError.message);}
      if(recorder&&!recordingStopped)try{await recorder.stop();}catch(stopError){cleanupErrors.push(stopError.message);}
      if(receipt?.state==='executing'&&receipt.params===params)await atomicJson(journal,{...receipt,state:'failed',completedAt:Date.now(),error:{code:e.code??'AUDIO_CAPTURE_FAILED',message:e.message,cleanupErrors}});
      if(e instanceof BridgeError){e.details={...e.details,requestId,cleanupErrors};throw e;}
      throw error(signal?.aborted?'REQUEST_CANCELLED':'AUDIO_CAPTURE_FAILED',e.message,{requestId,cleanupErrors});
    } finally { await release(); }
  }
}
