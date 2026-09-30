import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the actual hook with a minimal React lifecycle and browser boundary.
// No React renderer is shipped with this app's Node test setup.
async function fixture(t, getUserMedia) {
  const refs = [];
  const cleanups = [];
  const streams = [];
  const recorders = [];
  const makeStream = () => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { track, getTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  class Recorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor(stream) { super(); this.stream = stream; this.mimeType = 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.emitData('final'); this.dispatchEvent(new Event('stop')); }); }
    emitData(text) { const event = new Event('dataavailable'); event.data = new Blob([text]); this.dispatchEvent(event); }
  }
  const react = {
    useRef(value) { const ref = { current: value }; refs.push(ref); return ref; },
    useCallback(callback) { return callback; },
    useState(value) { return [value, () => {}]; },
    useEffect(callback) { cleanups.push(callback()); },
  };
  const restore = [];
  for (const [key, value] of Object.entries({
    __recorderTestReact: react,
    navigator: { mediaDevices: { getUserMedia: () => getUserMedia ? getUserMedia(makeStream) : Promise.resolve(makeStream()) } },
    MediaRecorder: Recorder,
    window: { setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    restore.push(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => { cleanups.forEach((cleanup) => cleanup?.()); restore.reverse().forEach((fn) => fn()); });
  const source = (await readFile(new URL('../hooks/useRecorder.js', import.meta.url), 'utf8'))
    .replace("import { useCallback, useEffect, useRef, useState } from 'react';", 'const { useCallback, useEffect, useRef, useState } = globalThis.__recorderTestReact;');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
  return { recorder: module.useRecorder(), refs, streams, recorders, cleanups };
}

test('stop releases all recorded chunks and recorder references', async (t) => {
  const { recorder, refs, recorders, streams } = await fixture(t);
  await recorder.start();
  recorders[0].emitData('first');
  const result = await recorder.stop();
  assert.equal(await result.blob.text(), 'firstfinal');
  assert.ok(streams[0].track.stopped);
  assert.equal(refs.some((ref) => Array.isArray(ref.current) && ref.current.some((item) => item instanceof Blob)), false);
  assert.equal(refs.some((ref) => ref.current === recorders[0]), false);
});

test('cancelling pending permission releases the stream without starting recording', async (t) => {
  let grant;
  const { recorder, streams, recorders } = await fixture(t, (makeStream) => new Promise((resolve) => { grant = () => resolve(makeStream()); }));
  const starting = recorder.start();
  recorder.cancel();
  grant();
  await starting;
  assert.ok(streams[0].track.stopped);
  assert.equal(recorders.length, 0);
});

test('concurrent start requests open only one microphone', async (t) => {
  let grant;
  const { recorder, streams, recorders } = await fixture(t, (makeStream) => new Promise((resolve) => { grant = () => resolve(makeStream()); }));
  const first = recorder.start();
  const second = recorder.start();
  grant();
  await first;
  await second;
  assert.equal(streams.length, 1);
  assert.equal(recorders.length, 1);
});

test('late data from cancelled recording cannot pollute the next recording', async (t) => {
  const { recorder, recorders } = await fixture(t);
  await recorder.start();
  const previous = recorders[0];
  recorder.cancel();
  await recorder.start();
  previous.emitData('stale');
  recorders[1].emitData('new');
  const result = await recorder.stop();
  assert.equal(await result.blob.text(), 'newfinal');
});
