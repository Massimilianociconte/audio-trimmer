// Exercise a real PWA update on an isolated localhost origin, preserving data.
// AUDIO_CUTTER_BASELINE_DIR=/path/to/previous/docs
// AUDIO_CUTTER_PLAYWRIGHT=/absolute/path/to/playwright node scripts/cache-migration-audit.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AUDIO_CUTTER_PLAYWRIGHT || 'playwright');
assert.ok(process.env.AUDIO_CUTTER_BASELINE_DIR, 'Provide the previous production build directory');
let root = resolve(process.env.AUDIO_CUTTER_BASELINE_DIR);
let generation = 0;
const prefix = '/audio-trimmer/';
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const path = resolve(root, url.pathname.slice(prefix.length) || 'index.html');
    if (!path.startsWith(root + '/') || !(await stat(path)).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store');
    const content = await readFile(path);
    response.end(extname(path) === '.js' && path.endsWith('/sw.js') && generation
      ? Buffer.concat([content, Buffer.from(`\n// test update ${generation}\n`)]) : content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${prefix}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  const legacyErrors = [];
  page.on('pageerror', error => {
    // The already-installed baseline has a known void.catch bug in its
    // update button. It still sends SKIP_WAITING before throwing. Record it;
    // the next update below verifies the fixed current client independently.
    if (error.message === "Cannot read properties of undefined (reading 'catch')" && error.stack?.includes('index-MzEvsjxY.js')) legacyErrors.push(error.message);
    else errors.push(error.message);
  });
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.evaluate(async () => {
    const scope = (await navigator.serviceWorker.getRegistration()).scope;
    for (const name of ['ffmpeg-wasm', 'ffmpeg-wasm-v1', 'ffmpeg-wasm-v2']) {
      const cache = await caches.open(name);
      await cache.put(scope + 'legacy-sentinel.wasm', new Response('obsolete'));
    }
    await (await caches.open('ffmpeg-wasm-v2')).put(new URL('/other-app/engine.wasm', scope).href, new Response('other-app'));
    localStorage.setItem('cache-migration-setting', 'preserved');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('audio-cutter-db', 2);
      request.onupgradeneeded = () => {
        for (const name of ['projects', 'projectMeta', 'projectAudio']) {
          const store = request.result.createObjectStore(name, { keyPath: 'id' });
          if (name !== 'projectAudio') store.createIndex('updatedAt', 'updatedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['projectMeta', 'projectAudio'], 'readwrite');
      tx.objectStore('projectMeta').put({ id: 'cache-migration-project', name: 'Preserved project', size: 11 });
      tx.objectStore('projectAudio').put({ id: 'cache-migration-project', blob: new Blob(['saved-audio']) });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  root = resolve('docs');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.getByRole('button', { name: 'Ricarica ora', exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => !!await (await caches.open('ffmpeg-wasm-v2')).match(new URL('legacy-sentinel.wasm', location.href))), true, 'waiting worker purged the active cache too early');
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Ricarica ora', exact: true }).click()]);
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated');
  const state = await page.evaluate(async () => {
    const scope = (await navigator.serviceWorker.getRegistration()).scope;
    const names = await caches.keys();
    const oldAudio = await (await caches.open('ffmpeg-wasm-v2')).match(scope + 'legacy-sentinel.wasm');
    const other = await (await caches.open('ffmpeg-wasm-v2')).match(new URL('/other-app/engine.wasm', scope).href);
    const db = await new Promise(resolve => { const request = indexedDB.open('audio-cutter-db', 2); request.onsuccess = () => resolve(request.result); });
    const audio = await new Promise(resolve => { const request = db.transaction('projectAudio').objectStore('projectAudio').get('cache-migration-project'); request.onsuccess = () => resolve(request.result); });
    db.close();
    const obsoleteAssets = [];
    for (const name of names.filter(name => name.startsWith('workbox-precache'))) {
      for (const request of await (await caches.open(name)).keys()) {
        if (/index-(?:MzEvsjxY|DSdGNrwC)\.js/.test(request.url)) obsoleteAssets.push(request.url);
      }
    }
    return { names, oldAudio: !!oldAudio, other: await other?.text(), savedAudio: await audio?.blob.text(), setting: localStorage.getItem('cache-migration-setting'), obsoleteAssets };
  });
  assert.equal(state.oldAudio, false);
  assert.equal(state.names.includes('ffmpeg-wasm'), false);
  assert.equal(state.names.includes('ffmpeg-wasm-v1'), false);
  assert.equal(state.other, 'other-app');
  assert.equal(state.savedAudio, 'saved-audio');
  assert.equal(state.setting, 'preserved');
  assert.deepEqual(state.obsoleteAssets, []);
  generation++;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.getByRole('button', { name: 'Ricarica ora', exact: true }).waitFor();
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Ricarica ora', exact: true }).click()]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ kind: 'real-pwa-cache-migration', passed: true, currentClientUpdatePassed: true, legacyErrors, ...state, errors }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
