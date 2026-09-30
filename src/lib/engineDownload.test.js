import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadEngineWasm } from './engineDownload.js';
const bytes = new Uint8Array([0,97,115,109,1,2,3,4]);
test('resumes a failed body read from the last delivered byte', async()=>{
 let calls=0;
 const blob=await downloadEngineWasm('local.wasm',{expectedBytes:8,stallMs:50,retryDelayMs:0,fetchImpl:async(url,options)=>{
  calls++;
  if(calls===1)return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,4));},pull(c){c.error(Error('network changed'));}}));
  assert.equal(options.headers.Range,'bytes=4-');return new Response(bytes.slice(4),{status:206,headers:{'Content-Range':'bytes 4-7/8'}});
 }});
 assert.equal(blob.size,8);assert.equal(calls,2);
});
test('aborted fetch releases network even while response headers never arrive',async()=>{
 const c=new AbortController();let networkAborted=false;
 const promise=downloadEngineWasm('local.wasm',{expectedBytes:8,stallMs:50,signal:c.signal,fetchImpl:(url,{signal})=>new Promise((r,j)=>signal.addEventListener('abort',()=>{networkAborted=true;j(signal.reason);}))});
 c.abort();await assert.rejects(promise,/abort/i);assert.ok(networkAborted);
});
test('a header stall times out and does not wait forever',async()=>{
 await assert.rejects(downloadEngineWasm('local.wasm',{expectedBytes:8,stallMs:5,maxAttempts:1,fetchImpl:()=>new Promise(()=>{})}),/stallo|connessione/i);
});
test('short or oversized complete responses are rejected',async()=>{
 for(const data of [bytes.slice(0,6),new Uint8Array(9)]) await assert.rejects(downloadEngineWasm('local.wasm',{expectedBytes:8,maxAttempts:1,fetchImpl:async()=>new Response(data)}),/incompleto|dimensione|corrotto/i);
});
test('incorrect Range start is rejected instead of concatenating unrelated bytes',async()=>{
 let n=0;
 await assert.rejects(downloadEngineWasm('local.wasm',{expectedBytes:8,stallMs:5,retryDelayMs:0,fetchImpl:async()=>++n===1?new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,4));}})):new Response(bytes,{status:206,headers:{'Content-Range':'bytes 0-7/8'}})}),/Range|ripresa/i);
});

test('compressed interrupted response restarts instead of using decoded Range offsets',async()=>{
 let calls=0;
 const blob=await downloadEngineWasm('local.wasm',{expectedBytes:8,retryDelayMs:0,fetchImpl:async(url,{headers})=>{
  if(++calls===1)return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,4));},pull(c){c.error(Error('disconnect'));}}),{headers:{'Content-Encoding':'gzip'}});
  assert.equal(headers.Range,undefined);return new Response(bytes);
 }});assert.equal(blob.size,8);assert.equal(calls,2);
});
