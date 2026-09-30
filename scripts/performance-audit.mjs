/** Local browser audit. Requires Playwright and Chrome; never uploads audio.
 * AUDIO_CUTTER_PLAYWRIGHT=/absolute/path/to/playwright node scripts/performance-audit.mjs
 * AUDIO_CUTTER_URL defaults to the production preview at http://127.0.0.1:4173
 * AUDIO_CUTTER_EXPORT=1 also runs 500 MiB exports, cancellation and storage checks.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { openSync, writeSync, closeSync, ftruncateSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.AUDIO_CUTTER_PLAYWRIGHT || 'playwright');
const url = process.env.AUDIO_CUTTER_URL || 'http://127.0.0.1:4173';
const output = process.env.AUDIO_CUTTER_AUDIT_DIR || join(tmpdir(), 'audio-cutter-audit');
mkdirSync(output, { recursive: true });

function fixture(mib, noise = false) {
  const size = mib * 1024 * 1024;
  const path = join(output, `${mib}MiB${noise ? '-noise' : ''}.wav`);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(size - 8, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44100, 24); header.writeUInt32LE(176400, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(size - 44, 40);
  const fd = openSync(path, 'w'); writeSync(fd, header);
  if (noise) {
    const chunk = Buffer.alloc(1024 * 1024);
    let seed = 12345;
    for (let i = 0; i < chunk.length; i += 2) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      chunk.writeInt16LE((seed >>> 17) - 16384, i);
    }
    let remaining = size - 44;
    while (remaining > 0) { const length = Math.min(remaining, chunk.length); writeSync(fd, chunk, 0, length); remaining -= length; }
  } else ftruncateSync(fd, size);
  closeSync(fd);
  return path;
}

const fixtures = (process.env.AUDIO_CUTTER_SIZES || '25,100,250,500').split(',').map(Number).map(mib => ({ mib, path: fixture(mib) }));
const browser = await chromium.launch({ channel: process.env.AUDIO_CUTTER_BROWSER || 'chrome', headless: true });
const results = [];

async function open(profile = 'desktop', destination = 'zip-classic') {
  assert.ok(profile === 'desktop' || devices[profile], `Unknown Playwright device profile: ${profile}`);
  const context = await browser.newContext({ ...(profile === 'desktop' ? {} : devices[profile]), acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ mobile, destination }) => {
    if (mobile) {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 });
    }
    localStorage.setItem('ac-export-dest', JSON.stringify(destination));
    if (destination === 'folder') window.showDirectoryPicker = () => navigator.storage.getDirectory();
    if (destination === 'zip-stream') window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('result.zip', { create: true });
    window.__audit = { reads: [], longTasks: [], audioWrites: 0, peakReportedHeap: 0 };
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () { window.__audit.reads.push(this.size); return read.call(this); };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'projectAudio') window.__audit.audioWrites++; return put.apply(this, args); };
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver(list => list.getEntries().forEach(entry => window.__audit.longTasks.push(entry.duration))).observe({ type: 'longtask' });
    }
    window.__auditTimer = setInterval(() => {
      window.__audit.peakReportedHeap = Math.max(window.__audit.peakReportedHeap, performance.memory?.usedJSHeapSize || 0);
    }, 100);
  }, { mobile: profile !== 'desktop', destination });
  if (profile !== 'desktop') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.goto(url);
  let peakRendererRSSBytes = 0;
  if (process.env.AUDIO_CUTTER_RSS === '1' && process.platform !== 'win32') {
    const cdp = await browser.newBrowserCDPSession();
    let sampling = false;
    const timer = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      try {
        const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
        const ids = processInfo.filter(p => p.type === 'renderer').map(p => p.id);
        if (ids.length) {
          const rss = execFileSync('ps', ['-p', ids.join(','), '-o', 'rss='], { encoding: 'utf8' });
          const bytes = rss.trim().split(/\s+/).reduce((sum, n) => sum + Number(n) * 1024, 0);
          peakRendererRSSBytes = Math.max(peakRendererRSSBytes, bytes);
        }
      } catch { /* renderer may have exited between snapshots */ }
      finally { sampling = false; }
    }, 50);
    context.on('close', () => { clearInterval(timer); cdp.detach().catch(() => {}); });
  }
  return { context, page, errors, rendererPeak: () => peakRendererRSSBytes };
}

async function load(page, path) {
  const started = performance.now();
  await page.getByLabel('Scegli un file audio').setInputFiles(path);
  await page.getByRole('heading', { name: path.split('/').at(-1), exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.loadbar') && !document.querySelector('.waveform-skeleton'));
  return Math.round(performance.now() - started);
}

try {
  for (const profile of (process.env.AUDIO_CUTTER_PROFILES || 'desktop,Pixel 5,iPhone 13').split(',')) {
    for (const { mib, path } of fixtures) {
      const { context, page, errors, rendererPeak } = await open(profile);
      const readyMs = await load(page, path);
      const idleMs = Number(process.env.AUDIO_CUTTER_IDLE_MS) || 0;
      if (idleMs > 0) await page.waitForTimeout(idleMs);
      const measured = await page.evaluate(() => ({ native: !!document.querySelector('.native-audio'), ...window.__audit }));
      assert.deepEqual(errors, []);
      if (measured.native) assert.ok(!measured.reads.includes(mib * 1024 * 1024), 'native preview read the entire File');
      results.push({ kind: 'load', profile, mib, readyMs, idleMs, measured, peakRendererRSSBytes: rendererPeak(), errors });
      console.log(JSON.stringify(results.at(-1)));
      await context.close();
    }
  }
  if (process.env.AUDIO_CUTTER_EXPORT === '1') {
    const audio = fixture(500, true);
    for (const profile of (process.env.AUDIO_CUTTER_PROFILES || 'desktop,Pixel 5,iPhone 13').split(',')) {
      const { context, page, errors, rendererPeak } = await open(profile);
      await load(page, audio);
      for (let run = 1; run <= (profile === 'desktop' ? 2 : 1); run++) {
        const started = performance.now();
        const downloaded = page.waitForEvent('download', { timeout: 180000 });
        await page.getByRole('button', { name: 'Taglia e scarica 2 parti M4A', exact: true }).click();
        const download = await downloaded;
        const zipPath = join(output, `${profile.replaceAll(' ', '-')}-${run}.zip`);
        await download.saveAs(zipPath);
        assert.equal(await download.failure(), null);
        const { ZipReader, BlobReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
        const reader = new ZipReader(new BlobReader(new Blob([readFileSync(zipPath)])));
        const entries = await reader.getEntries(); assert.equal(entries.length, 2);
        for (const entry of entries) {
          assert.ok(entry.uncompressedSize > 1024 * 1024, 'output unexpectedly tiny');
          await entry.getData(new Uint8ArrayWriter(), { checkSignature: true }); // CRC validation
        }
        await reader.close();
        results.push({ kind: 'export', profile, run, elapsedMs: Math.round(performance.now() - started), zipPath, peakRendererRSSBytes: rendererPeak(), entries: entries.map(e => ({ name: e.filename, bytes: e.uncompressedSize })), errors, measured: await page.evaluate(() => window.__audit) });
        assert.deepEqual(errors, []);
        console.log(JSON.stringify(results.at(-1)));
      }
      // Interrupt a real worker job, then check input and export controls recover.
      await page.getByRole('button', { name: 'Taglia e scarica 2 parti M4A', exact: true }).click();
      await page.getByRole('button', { name: /Annulla/, exact: false }).first().click();
      await page.getByRole('button', { name: 'Taglia e scarica 2 parti M4A', exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.export-progress'));
      // Too-large WAV output must fail before starting a worker encoding.
      await page.getByText('Impostazioni export (opzionale: formato, qualità, destinazione)', { exact: true }).click();
      await page.getByRole('combobox', { name: /Formato/ }).selectOption('wav');
      await page.getByRole('button', { name: 'Taglia e scarica 2 parti WAV', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: /Risultato troppo grande/ }).waitFor();
      results.push({ kind: 'cancel-and-budget', profile, passed: true });
      console.log(JSON.stringify(results.at(-1)));
      await context.close();
    }
    if (process.env.AUDIO_CUTTER_DISK === '1') {
      for (const destination of ['folder', 'zip-stream']) {
        const { context, page, errors } = await open('desktop', destination);
        await load(page, audio);
        const started = performance.now();
        await page.getByRole('button', { name: 'Taglia e scarica 2 parti M4A', exact: true }).click();
        await page.waitForFunction(mode => document.body.textContent.includes(mode === 'folder' ? 'Cartella: 2 parti scritte su disco' : 'ZIP su disco: 2 parti'), destination, { timeout: 180000 });
        // Real OPFS handles exercise the browser filesystem; only the picker
        // dialog is replaced, so no user folders are touched by automation.
        const files = await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory(); const result = [];
          for await (const [name, handle] of root.entries()) {
            if (handle.kind !== 'file') continue;
            const file = await handle.getFile();
            result.push({ name, bytes: file.size, signature: [...new Uint8Array(await file.slice(0, 8).arrayBuffer())] });
          }
          return result;
        });
        assert.deepEqual(errors, []);
        assert.equal(files.length, destination === 'folder' ? 2 : 1);
        assert.ok(files.every(file => file.bytes > 1024 * 1024));
        results.push({ kind: 'disk-export', destination, elapsedMs: Math.round(performance.now() - started), files, errors });
        console.log(JSON.stringify(results.at(-1))); await context.close();
      }
    }
    // Consecutive metadata saves must write the audio only once.
    const { context, page } = await open(); await load(page, fixtures[0].path);
    await page.getByText('Progetto, JSON e trascrizione AI (opzionale)', { exact: true }).click();
    await page.getByRole('button', { name: 'Salva progetto', exact: true }).click();
    await page.getByRole('button', { name: 'Aggiorna progetto salvato', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Aggiorna progetto salvato', exact: true }).click();
    await page.getByRole('button', { name: 'Aggiorna progetto salvato', exact: true }).isEnabled();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Aggiorna progetto salvato')?.disabled);
    assert.equal(await page.evaluate(() => window.__audit.audioWrites), 1);
    results.push({ kind: 'metadata-save', audioWrites: 1, passed: true });
    // Hold the final cleanup metadata callback open: no second job or file
    // may start between worker completion and publication of the new audio.
    await load(page, fixture(1));
    await page.getByText('Pulizia audio e capitoli automatici (opzionale)', { exact: true }).click();
    await page.evaluate(() => {
      const create = document.createElement.bind(document);
      document.createElement = (tag, ...args) => {
        const element = create(tag, ...args);
        if (tag === 'audio') {
          window.__cleanupProbeOpened = true;
          let callback;
          Object.defineProperty(element, 'onloadedmetadata', { get: () => callback, set: value => { callback = value; } });
          element.addEventListener('loadedmetadata', () => setTimeout(() => callback?.(), 1000));
        }
        return element;
      };
    });
    await page.getByRole('button', { name: 'Applica a tutto il file', exact: true }).click();
    await page.waitForFunction(() => window.__cleanupProbeOpened);
    assert.equal(await page.getByRole('button', { name: 'Applica a tutto il file', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Attendi: operazione in corso…', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Scegli un file audio').isDisabled(), true);
    await page.getByText('Pulizia applicata:', { exact: false }).first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.waveform-skeleton'));
    results.push({ kind: 'cleanup-finalization-lock', passed: true });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
} finally {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ url, browser: browser.version(), results }, null, 2));
  await browser.close();
}
console.log(`Report: ${join(output, 'results.json')}`);
