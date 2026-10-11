import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='darwin') throw new Error('The audio helper requires macOS 14.2+ and Xcode Command Line Tools.');
const app=path.join(root,'.build/macos/SVAudioCapture.app');
await fs.mkdir(path.join(app,'Contents/MacOS'),{recursive:true});
await fs.copyFile(path.join(root,'native/macos/Info.plist'),path.join(app,'Contents/Info.plist'));
for(const [command,args] of [
  ['xcrun',['swiftc','-O','-swift-version','5','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos14.2`,'-module-cache-path',path.join(root,'.build/module-cache'),path.join(root,'native/macos/SVAudioCapture.swift'),'-o',path.join(app,'Contents/MacOS/SVAudioCapture'),'-framework','CoreAudio','-framework','AVFoundation','-framework','AppKit']],
  ['codesign',['--force','--sign','-','--identifier','com.svbridge4agent.audio-capture',app]],
]) {
  const result=spawnSync(command,args,{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status??1);
}
console.log(app);
