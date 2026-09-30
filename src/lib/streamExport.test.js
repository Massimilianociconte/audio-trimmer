import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_DESTINATION_ORDER,
  EXPORT_DESTINATIONS,
  HEAVY_INPUT_BYTES,
  HEAVY_OUTPUT_BYTES,
  RETAIN_BLOBS_BYTES,
  adviseExportStrategy,
  clearCheckpoint,
  getExportCapabilities,
  readCheckpoint,
  writeCheckpoint,
} from './streamExport.js';

test('destination registry is complete', () => {
  for (const id of EXPORT_DESTINATION_ORDER) {
    assert.ok(EXPORT_DESTINATIONS[id], `missing destination ${id}`);
  }
});

test('getExportCapabilities detects APIs from env', () => {
  const full = getExportCapabilities({
    showDirectoryPicker: () => {},
    showSaveFilePicker: () => {},
    navigator: { wakeLock: { request: () => {} } },
    WritableStream: function () {},
  });
  assert.equal(full.directoryPicker, true);
  assert.equal(full.filePicker, true);
  assert.equal(full.wakeLock, true);
  assert.equal(full.webStreams, true);

  const empty = getExportCapabilities({});
  assert.equal(empty.directoryPicker, false);
  assert.equal(empty.filePicker, false);
  assert.equal(empty.wakeLock, false);
});

test('heavy jobs prefer folder when available', () => {
  const { mode } = adviseExportStrategy({
    fileSizeBytes: HEAVY_INPUT_BYTES + 1,
    totalEstimateBytes: 10,
    segmentCount: 2,
    capabilities: { directoryPicker: true, filePicker: true },
  });
  assert.equal(mode, 'folder');
});

test('heavy output prefers folder, falls back to zip-stream', () => {
  const folder = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: HEAVY_OUTPUT_BYTES + 1,
    segmentCount: 2,
    capabilities: { directoryPicker: true, filePicker: true },
  });
  assert.equal(folder.mode, 'folder');

  const stream = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: HEAVY_OUTPUT_BYTES + 1,
    segmentCount: 2,
    capabilities: { directoryPicker: false, filePicker: true },
  });
  assert.equal(stream.mode, 'zip-stream');
});

test('many segments trigger incremental writing', () => {
  const { mode, reasons } = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: 10,
    segmentCount: 30,
    capabilities: { directoryPicker: true, filePicker: true },
  });
  assert.equal(mode, 'folder');
  assert.match(reasons.join(' '), /incrementale|disco/i);
});

test('small jobs use in-memory zip when no file picker', () => {
  const { mode } = adviseExportStrategy({
    fileSizeBytes: 1024,
    totalEstimateBytes: RETAIN_BLOBS_BYTES - 1,
    segmentCount: 3,
    capabilities: { directoryPicker: false, filePicker: false },
  });
  assert.equal(mode, 'zip-classic');
});

test('huge jobs without file APIs fall back to singles with warning', () => {
  const { mode, warnings } = adviseExportStrategy({
    fileSizeBytes: 1024,
    totalEstimateBytes: RETAIN_BLOBS_BYTES + 1,
    segmentCount: 3,
    capabilities: { directoryPicker: false, filePicker: false },
  });
  assert.equal(mode, 'singles');
  assert.ok(warnings.length > 0);
});

test('manual preference wins when supported', () => {
  const { mode } = adviseExportStrategy({
    fileSizeBytes: HEAVY_INPUT_BYTES + 1,
    totalEstimateBytes: HEAVY_OUTPUT_BYTES + 1,
    segmentCount: 99,
    capabilities: { directoryPicker: true, filePicker: true },
    preference: 'singles',
  });
  assert.equal(mode, 'singles');
});

test('manual folder without support falls back with warning', () => {
  const { mode, warnings } = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: 10,
    segmentCount: 2,
    capabilities: { directoryPicker: false, filePicker: true },
    preference: 'folder',
  });
  assert.equal(mode, 'zip-stream');
  assert.ok(warnings.length > 0);
});

test('manual zip-stream without filePicker falls back to zip-classic', () => {
  const { mode, warnings } = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: 10,
    segmentCount: 2,
    capabilities: { directoryPicker: false, filePicker: false },
    preference: 'zip-stream',
  });
  assert.equal(mode, 'zip-classic');
  assert.ok(warnings.length > 0);
});

test('checkpoint round-trips through stubbed localStorage', () => {
  const store = new Map();
  const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => void store.set(key, String(value)),
      removeItem: (key) => void store.delete(key),
    },
  });
  try {
    assert.equal(readCheckpoint(), null);
    writeCheckpoint({ baseName: 'lezione', total: 4, doneCount: 2 });
    const restored = readCheckpoint();
    assert.equal(restored.baseName, 'lezione');
    assert.equal(restored.doneCount, 2);
    assert.ok(Number.isFinite(restored.savedAt));
    clearCheckpoint();
    assert.equal(readCheckpoint(), null);
  } finally {
    if (realDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', realDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('ZIP STORE roundtrip and errors do not retry a failed entry', async () => {
 const { createZipStreamWriter } = await import('./streamExport.js');
 let writes = 0;
 const writable = new WritableStream({ write() { writes++; throw new Error('disk full'); } });
 const writer = await createZipStreamWriter(writable);
 await assert.rejects(writer.add('audio.mp3', new Uint8Array(1024)), /disk full/);
 await writer.abort();
 assert.equal(writes, 1);
});

test('abort cancels an active ZIP add rather than finalizing partial output', async () => {
 const { createZipStreamWriter } = await import('./streamExport.js');
 const controller = new AbortController();
 let cancelled = false;
 const writer = await createZipStreamWriter(new WritableStream({
   write() { controller.abort(); }, abort() { cancelled = true; },
 }), { signal: controller.signal });
 await assert.rejects(writer.add('audio.wav', new Uint8Array(1024 * 1024)), /abort/i);
 await writer.abort();
 assert.ok(cancelled);
});

test('file write cancellation aborts the writable and prevents success', async () => {
 const { writeBlobToFileHandle } = await import('./streamExport.js');
 const controller=new AbortController();let aborted=false;let closed=false;
 const file={createWritable:async()=>({write:async()=>controller.abort(),abort:async()=>{aborted=true;},close:async()=>{closed=true;}})};
 await assert.rejects(writeBlobToFileHandle(file,new Uint8Array(10),{signal:controller.signal}),/abort/i);
 assert.ok(aborted);assert.equal(closed,false);
});

test('ZIP blob output roundtrips stored bytes without compression', async()=>{
 const { createZipBlobWriter }=await import('./streamExport.js');
 const { ZipReader, BlobReader, Uint8ArrayWriter }=await import('@zip.js/zip.js');
 const writer=await createZipBlobWriter();const data=new Uint8Array([1,2,3]);await writer.add('clip.mp3',data);const blob=await writer.close();
 const reader=new ZipReader(new BlobReader(blob));const [entry]=await reader.getEntries();assert.equal(entry.compressionMethod,0);assert.deepEqual(await entry.getData(new Uint8ArrayWriter()),data);await reader.close();
});

test('ZIP cancellation interrupts a stalled central directory and never commits', async()=>{
 const {createZipStreamWriter}=await import('./streamExport.js');
 const controller=new AbortController();let releaseWrite;let stall=false;let committed=false;
 const sink=new WritableStream({write(){if(stall)return new Promise(r=>{releaseWrite=r;});},close(){committed=true;}});
 const writer=await createZipStreamWriter(sink,{signal:controller.signal});await writer.add('clip.mp3',new Uint8Array([1,2,3]));stall=true;
 const closing=writer.close();await new Promise(r=>setTimeout(r,10));controller.abort();
 const outcome=await Promise.race([closing.then(()=> 'success',()=> 'aborted'),new Promise(r=>setTimeout(()=>r('pending'),50))]);
 releaseWrite?.();await writer.abort();assert.equal(outcome,'aborted');assert.equal(committed,false);
});

test('folder cancellation rejects a stalled write before the sink completes',async()=>{
 const {writeBlobToFileHandle}=await import('./streamExport.js');const controller=new AbortController();let releaseWrite;let committed=false;
 const writable=new WritableStream({write(){return new Promise(r=>{releaseWrite=r;});},close(){committed=true;}});
 writable.write = (data) => { const w=writable.getWriter(); return w.write(data).finally(()=>w.releaseLock()); };
 const pending=writeBlobToFileHandle({createWritable:async()=>writable},new Uint8Array(10),{signal:controller.signal});
 pending.catch(()=>{});
 await new Promise(r=>setTimeout(r,10));controller.abort();
 const outcome=await Promise.race([pending.then(()=> 'success',()=> 'aborted'),new Promise(r=>setTimeout(()=>r('pending'),50))]);
 releaseWrite?.();assert.equal(outcome,'aborted');assert.equal(committed,false);
});
