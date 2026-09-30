import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../../public/cache-migration.js', import.meta.url), 'utf8');
const scope = 'https://example.test/audio-trimmer/';
async function activate(seed) {
  const entries = new Map(Object.entries(seed).map(([name, urls]) => [name, new Set(urls)]));
  const listeners = new Map();
  const storage = {
    keys: async () => [...entries.keys()],
    delete: async name => entries.delete(name),
    open: async name => ({
      keys: async () => [...entries.get(name)].map(url => ({ url })),
      delete: async request => entries.get(name).delete(request.url),
    }),
  };
  runInNewContext(script, { self: { registration: { scope }, addEventListener: (name, callback) => listeners.set(name, callback) }, caches: storage });
  assert.deepEqual([...listeners.keys()], ['activate']);
  let completed;
  listeners.get('activate')({ waitUntil: promise => { completed = promise; } });
  await completed;
  return entries;
}

test('activation purges legacy audio caches while preserving the new cache and application data', async () => {
  const entries = await activate({
    'ffmpeg-wasm': [scope + 'old.wasm'],
    'ffmpeg-wasm-v1': [scope + 'v1.wasm'],
    'ffmpeg-wasm-v2': [scope + 'v2.wasm'],
    'audio-cutter-ffmpeg-wasm-v3': [scope + 'current.wasm'],
    'workbox-precache-current': [scope + 'index.html'],
    'other-cache': ['https://example.test/other/asset'],
  });
  assert.deepEqual([...entries.keys()], ['audio-cutter-ffmpeg-wasm-v3', 'workbox-precache-current', 'other-cache']);
  // No indexedDB/localStorage/unregister/skipWaiting is exposed in the VM:
  // activation can only mutate CacheStorage, through event.waitUntil.
});

test('legacy shared cache keeps content belonging to another app on the same origin', async () => {
  const other = 'https://example.test/other-app/engine.wasm';
  const entries = await activate({ 'ffmpeg-wasm-v2': [scope + 'engine.wasm', other] });
  assert.deepEqual([...entries.get('ffmpeg-wasm-v2')], [other]);
});

test('cache migration failure does not block service worker activation', async () => {
  let activate;
  runInNewContext(script, {
    self: { registration: { scope }, addEventListener: (_, callback) => { activate = callback; } },
    caches: { keys: async () => { throw new Error('storage unavailable'); } },
  });
  let completed;
  activate({ waitUntil: promise => { completed = promise; } });
  await completed;
});

test('engine and generated service worker use the same cache namespace and import the migration', () => {
  const config = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
  const engine = readFileSync(new URL('../hooks/useFfmpegEngine.js', import.meta.url), 'utf8');
  assert.ok(config.includes("cacheName: 'audio-cutter-ffmpeg-wasm-v3'"));
  assert.ok(engine.includes("ENGINE_CACHE_NAME = 'audio-cutter-ffmpeg-wasm-v3'"));
  assert.ok(config.includes("importScripts: ['./cache-migration.js']"));
});
