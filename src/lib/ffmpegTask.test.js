import test from 'node:test';
import assert from 'node:assert/strict';
import { runFfmpeg, runFfprobe } from './ffmpegTask.js';
function engine(work) {
 const callbacks=new Map();return {on:(e,f)=>callbacks.set(e,f),off:(e)=>callbacks.delete(e),exec:async(args)=>work(args,callbacks),callbacks};
}
test('output safety applies -fs before the output path',async()=>{
 const ffmpeg=engine(args=>{assert.deepEqual(args.slice(-3),['-fs','32','out.wav']);return 0;});
 await runFfmpeg(ffmpeg,['-i','input','out.wav'],{maxOutputBytes:32});
});
test('progress bursts publish at most five times per second plus completion',async()=>{
 let reports=0;const ffmpeg=engine((args,c)=>{for(let i=0;i<=1000;i++)c.get('progress')({time:i*1000});return 0;});
 await runFfmpeg(ffmpeg,['-f','null','-'],{durationSeconds:1,onProgress:()=>reports++});
 assert.ok(reports<=2,`got ${reports} reports`);assert.equal(ffmpeg.callbacks.size,0);
});
test('captured logs have a finite budget and listeners release on overflow',async()=>{
 const ffmpeg=engine((args,c)=>{for(let i=0;i<100;i++)c.get('log')({message:'x'.repeat(100)});return 0;});
 await assert.rejects(runFfmpeg(ffmpeg,[],{captureLog:true,maxLogBytes:1000}),/log.*limite|limite.*log/);assert.equal(ffmpeg.callbacks.size,0);
});
test('capture filtering preserves useful silence lines only',async()=>{
 const ffmpeg=engine((args,c)=>{c.get('log')({message:'unrelated'});c.get('log')({message:'silence_start: 1'});return 0;});
 const result=await runFfmpeg(ffmpeg,[],{captureLog:line=>line.includes('silence_')});assert.equal(result.logText,'silence_start: 1');
});

test('a silent dead worker is terminated after the activity deadline',async()=>{
 const ffmpeg=engine(()=>new Promise(()=>{}));let terminated=0;ffmpeg.terminate=()=>terminated++;
 await assert.rejects(runFfmpeg(ffmpeg,[],{stallTimeoutMs:10}),/risponde|memoria|bloccato/i);assert.equal(terminated,1);assert.equal(ffmpeg.callbacks.size,0);
});

test('a metadata probe with a dead worker has a bounded wait', async () => {
 let terminated = 0;
 const ffmpeg = { ffprobe: () => new Promise(() => {}), terminate: () => terminated++ };
 await assert.rejects(runFfprobe(ffmpeg, [], { timeoutMs: 5 }), /metadati|risponde/i);
 assert.equal(terminated, 1);
});

test('metadata probe preserves the core exit code and clears its deadline', async () => {
 let terminated = 0;
 const ffmpeg = { ffprobe: async args => { assert.deepEqual(args, ['input']); return -1; }, terminate: () => terminated++ };
 assert.equal(await runFfprobe(ffmpeg, ['input'], { timeoutMs: 5 }), -1);
 await new Promise(resolve => setTimeout(resolve, 10));
 assert.equal(terminated, 0);
});
