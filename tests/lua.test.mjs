import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('Lua JSON, edit validation, replay journal and lifecycle',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sv-lua-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const folder of ['requests','replies','receipts','cancellations']) await fs.mkdir(path.join(dir,folder));
  const child=spawnSync(process.env.LUA_BIN??'lua',['tests/lua-unit.lua',dir,path.resolve('lua')],{encoding:'utf8'});
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  assert.match(child.stdout,/all Lua checks passed/);
});
