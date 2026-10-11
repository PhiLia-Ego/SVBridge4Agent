import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { FileQueue, atomicJson, readJson } from '../src/queue.mjs';

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'sv-queue-test-'));
  t.after(async () => {
    await dirCleanup.get(dir)?.();
    await fs.rm(dir,{recursive:true,force:true});
  });
  const queue = new FileQueue(dir); await queue.prepare();
  const session={protocolVersion:1,sessionId:'test-session',state:'running',heartbeatAt:Date.now(),projectFile:'/test/project.svp'};
  await atomicJson(path.join(dir,'session.json'),session);
  return {dir,queue,session};
}
const dirCleanup = new Map();
function echoWorker(t,dir,session,mutate=x=>x) {
  let done=false;
  const work=(async()=>{
    while(!done) {
      await atomicJson(path.join(dir,'session.json'),{...session,heartbeatAt:Date.now()});
      const index=await readJson(path.join(dir,'queue.json'),true);
      for(const item of index?.entries??[]) {
        const file=path.join(dir,'replies',`${item.id}.json`);
        if(await readJson(file,true)) continue;
        await atomicJson(file,mutate({protocolVersion:1,id:item.id,sessionId:session.sessionId,ok:true,result:{echo:item.id}}));
      }
      await sleep(5);
    }
  })();
  dirCleanup.set(dir,async()=>{done=true;await work;dirCleanup.delete(dir);});
}
test('concurrent processes publish without losing requests',async t=>{
  const {dir,session}=await setup(t); echoWorker(t,dir,session);
  const module=path.resolve('src/queue.mjs');
  const children=Array.from({length:4},(_,worker)=>new Promise((resolve,reject)=>{
    const code=`import { FileQueue } from ${JSON.stringify(module)}; const q=new FileQueue(${JSON.stringify(dir)}); await Promise.all(Array.from({length:8},(_,i)=>q.request('read',{}, {requestId:'worker-${worker}-'+i,timeoutMs:10000})));`;
    const child=spawn(process.execPath,['--input-type=module','-e',code]); let err='';
    child.stderr.on('data',x=>{err+=x;}); child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(new Error(err)));
  }));
  await Promise.all(children);
  const files=await fs.readdir(path.join(dir,'replies')); assert.equal(files.length,32);
});
test('retry keeps one request and rejects changed payload/session',async t=>{
  const {dir,queue,session}=await setup(t); echoWorker(t,dir,session);
  const first=await queue.request('read',{x:1},{requestId:'same'});
  assert.deepEqual(await queue.request('read',{x:1},{requestId:'same'}),first);
  await assert.rejects(queue.request('read',{x:2},{requestId:'same'}),{code:'REQUEST_ID_CONFLICT'});
  await assert.rejects(queue.request('read',{}, {sessionId:'another'}),{code:'SESSION_CHANGED'});
  assert.equal((await fs.readdir(path.join(dir,'requests'))).length,1);
});
test('mismatched replies and stale sessions cannot appear successful',async t=>{
  const {dir,queue,session}=await setup(t);
  await atomicJson(path.join(dir,'session.json'),{...session,heartbeatAt:Date.now()-7000});
  await assert.rejects(queue.request('read'),{code:'BRIDGE_OFFLINE'});
  await atomicJson(path.join(dir,'session.json'),session);
  echoWorker(t,dir,session,x=>({...x,id:'wrong'}));
  await assert.rejects(queue.request('read',{}, {requestId:'valid'}),{code:'REPLY_MISMATCH'});
  await assert.rejects(queue.result('valid'),{code:'REPLY_MISMATCH'});
  await assert.rejects(queue.request('read',{}, {requestId:'../bad'}),{code:'INVALID_REQUEST_ID'});
});
test('timeout creates cancellation and leaves the original request inspectable',async t=>{
  const {queue}=await setup(t);
  await assert.rejects(queue.request('edit',{x:1},{requestId:'timeout',timeoutMs:2000}),error=>error.code==='REQUEST_TIMEOUT' && error.details.requestId==='timeout');
  assert.equal((await readJson(queue.file('cancellations','timeout'))).id,'timeout');
  const saved=await queue.result('timeout'); assert.equal(saved.request.method,'edit'); assert.equal(saved.reply,null);
});
test('oversized and already-cancelled requests are never published',async t=>{
  const {dir,queue}=await setup(t);
  await assert.rejects(queue.request('edit',{lyrics:'x'.repeat(512*1024)},{requestId:'large'}),{code:'REQUEST_TOO_LARGE'});
  await assert.rejects(queue.request('edit',{}, {requestId:'cancelled',signal:AbortSignal.abort()}),{code:'REQUEST_CANCELLED'});
  assert.deepEqual(await fs.readdir(path.join(dir,'requests')),[]);
});
test('atomic replacement never exposes partial large JSON',async t=>{
  const {dir}=await setup(t); const file=path.join(dir,'large.json');
  const payload='中文🎵'.repeat(50000); await atomicJson(file,{i:0,payload}); let running=true; let reads=0;
  const reader=(async()=>{while(running){const value=await readJson(file);assert.equal(value.payload,payload);reads++;}})();
  for(let i=1;i<=30;i++) await atomicJson(file,{i,payload});
  running=false;await reader;assert.ok(reads>0);assert.equal((await readJson(file)).i,30);
});
