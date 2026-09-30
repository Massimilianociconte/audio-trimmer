import test from 'node:test';
import assert from 'node:assert/strict';
import { outputMemoryPolicy, assertOutputBudget, mountAudioInput, readAudioOutput } from './memoryPolicy.js';
const mobile = {navigator:{userAgent:'iPhone',hardwareConcurrency:4}};
const desktop = {navigator:{deviceMemory:8,hardwareConcurrency:8}};
test('output budget is conservative on mobile and low memory desktops',()=>{
 assert.equal(outputMemoryPolicy(mobile).segmentBytes,32*1024*1024);
 assert.ok(outputMemoryPolicy({navigator:{deviceMemory:2}}).segmentBytes < outputMemoryPolicy(desktop).segmentBytes);
 assert.throws(()=>assertOutputBudget(500*1024*1024,mobile),/parti|M4A/);
});
test('WORKERFS mount of a 500 MiB input never reads the full blob', async()=>{
 const blob={size:500*1024*1024,arrayBuffer(){throw Error('full read');}};
 const calls=[];const ffmpeg={createDir:async()=>{},mount:async(...a)=>{calls.push(a);return true;}};
 const mounted=await mountAudioInput(ffmpeg,{blob,extension:'.wav'},1,mobile);
 assert.equal(mounted.memfs,false);assert.equal(calls[0][1].blobs[0].data,blob);
});
test('unavailable WORKERFS fails before reading a large input',async()=>{
 let reads=0;const blob={size:500*1024*1024,arrayBuffer:async()=>{reads++;return new ArrayBuffer(1);}};
 const ffmpeg={createDir:async()=>{},mount:async()=>false,deleteDir:async()=>{}};
 await assert.rejects(mountAudioInput(ffmpeg,{blob},2,mobile),/WORKERFS|copia integrale/);assert.equal(reads,0);
});
test('terminated worker does not trigger a full-file fallback',async()=>{
 let reads=0;const blob={size:1,arrayBuffer:async()=>{reads++;}};
 const ffmpeg={loaded:false,createDir:async()=>{throw Error('terminated');},deleteDir:async()=>{}};
 await assert.rejects(mountAudioInput(ffmpeg,{blob},3),/terminated/);assert.equal(reads,0);
});
test('a limited output is deleted and never returned as a successful file',async()=>{
 const deleted=[];const ffmpeg={readFile:async()=>new Uint8Array(16),deleteFile:async(path)=>deleted.push(path)};
 await assert.rejects(readAudioOutput(ffmpeg,'out.wav',16),/limite/);assert.deepEqual(deleted,['out.wav']);
});
test('successful output is also removed before returning transferred bytes',async()=>{
 const bytes=new Uint8Array(4);let deleted=false;
 assert.equal(await readAudioOutput({readFile:async()=>bytes,deleteFile:async()=>{deleted=true;}},'out',16),bytes);assert.equal(deleted,true);
});
