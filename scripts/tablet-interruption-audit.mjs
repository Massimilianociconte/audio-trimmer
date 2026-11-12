/** Interruzioni su tablet emulati (iPad/WebKit, Galaxy Tab/Chromium). Locale, nessun upload.
 * AUDIO_CUTTER_PLAYWRIGHT=/percorso/assoluto/playwright node scripts/tablet-interruption-audit.mjs
 * AUDIO_CUTTER_URL            build di produzione (default http://127.0.0.1:4173/)
 * AUDIO_CUTTER_PROFILES       default 'iPad (gen 11),Galaxy Tab S9'
 * AUDIO_CUTTER_SCENARIOS      default 'kill,reload,crash,freeze,idle,delivery'
 *
 * kill     processo renderer ucciso (SIGKILL) dopo 2 parti → nuova scheda → stesso file
 *          → ripresa: le parti salvate non si rifanno, ZIP identico (CRC) a un export completo
 * reload   ricaricamento della pagina a metà export, poi come sopra
 * crash    worker del motore chiuso a metà export → errore entro la scadenza → «Riprova» riprende
 * freeze   processo renderer sospeso 30 s (SIGSTOP/SIGCONT, come iPadOS/Android in background)
 * idle     app nascosta a riposo → motore liberato → export successivo funziona
 * delivery file singoli (Android, 2 parti): dopo il reload si scarica solo la parte mancante
 *
 * SIGKILL/SIGSTOP usano `ps` (macOS/Linux) e colpiscono i renderer dei browser Playwright:
 * non tenere aperti altri browser Playwright durante la prova. WebKit usa un profilo su disco
 * (Safari normale): il contesto effimero equivale alla navigazione privata, dove WebKit
 * rifiuta i Blob in IndexedDB e la ripresa non è disponibile (limite documentato).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';

const require = createRequire(import.meta.url);
const pw = require(process.env.AUDIO_CUTTER_PLAYWRIGHT || 'playwright');
const url = process.env.AUDIO_CUTTER_URL || 'http://127.0.0.1:4173/';
const profiles = (process.env.AUDIO_CUTTER_PROFILES || 'iPad (gen 11),Galaxy Tab S9').split(',').map((s) => s.trim());
const scenarios = (process.env.AUDIO_CUTTER_SCENARIOS || 'kill,reload,crash,freeze,idle,delivery').split(',').map((s) => s.trim());
const output = process.env.AUDIO_CUTTER_AUDIT_DIR || join(tmpdir(), 'audio-cutter-tablet-audit');
const FREEZE_MS = 30000;
mkdirSync(output, { recursive: true });

// 20 minuti di rumore PCM16 stereo 44,1 kHz (~202 MiB): con la conversione in MP3 la
// stima di lavoro supera la soglia di salvataggio delle parti (15 s) anche su un PC veloce.
function noiseWav(seconds = 1200) {
  const path = join(output, `noise-${seconds}s.wav`);
  const dataBytes = seconds * 44100 * 4;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44100, 24); header.writeUInt32LE(176400, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const fd = openSync(path, 'w');
  writeSync(fd, header);
  const chunk = Buffer.alloc(1024 * 1024);
  let seed = 12345;
  for (let i = 0; i < chunk.length; i += 2) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    chunk.writeInt16LE(((seed >>> 17) - 16384) >> 2, i);
  }
  for (let left = dataBytes; left > 0; left -= chunk.length) writeSync(fd, chunk, 0, Math.min(left, chunk.length));
  closeSync(fd);
  return path;
}

function rendererPids(engine) {
  const pattern = engine === 'chromium' ? /--type=renderer/ : /WebContent|WebProcess/;
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 1 << 24 })
    .split('\n')
    .filter((line) => line.includes('ms-playwright') && pattern.test(line))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter(Number.isInteger);
}

async function runScenario(profile, scen, audioPath) {
  const device = pw.devices[profile];
  if (!device) throw new Error(`Profilo Playwright sconosciuto: ${profile}`);
  const engine = device.defaultBrowserType || 'chromium';
  const android = /Android/.test(device.userAgent || '');
  const parts = scen === 'delivery' || scen === 'idle' ? 2 : 4;
  const result = { profile, scen, ok: false, checks: {} };
  const check = (name, value) => { result.checks[name] = value; };
  let browser = null;
  let context;
  let profileDir = null;
  if (engine === 'webkit') {
    profileDir = mkdtempSync(join(output, 'webkit-profile-'));
    context = await pw.webkit.launchPersistentContext(profileDir, { headless: true, ...device, acceptDownloads: true });
  } else {
    browser = await pw[engine].launch({ headless: true });
    context = await browser.newContext({ ...device, acceptDownloads: true });
  }
  const errors = [];
  const workers = [];
  const downloads = [];
  const wire = (target) => {
    target.on('pageerror', (error) => errors.push(error.message));
    target.on('download', (download) => downloads.push(download.suggestedFilename()));
    target.on('worker', (worker) => {
      workers.push('open');
      worker.on('close', () => workers.push('closed'));
    });
  };
  await context.addInitScript(({ android: isAndroid }) => {
    if (isAndroid) {
      // Chrome Android non ha i picker del file system.
      delete window.showSaveFilePicker;
      delete window.showDirectoryPicker;
      delete window.showOpenFilePicker;
    }
    // Headless resta sempre "visible": visibilità pilotata dal test.
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    window.__setHidden = (value) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
    // WebKit headless non emette eventi download: si tiene traccia dei link scaricati.
    window.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function trackedClick() {
      if (this.download) window.__downloads.push({ name: this.download, url: this.href });
      return click.call(this);
    };
  }, { android });
  let page = context.pages()[0] ?? await context.newPage();
  wire(page);

  const text = () => page.evaluate(() => document.body.innerText);
  const chips = () => page.evaluate(() => ({
    done: document.querySelectorAll('.part-chip-done').length,
    skipped: document.querySelectorAll('.part-chip-skipped').length,
  }));
  const loadFile = async () => {
    await page.getByLabel('Scegli un file audio').setInputFiles(audioPath);
    await page.waitForFunction(() => /File pronto/.test(document.body.innerText), null, { timeout: 120000 });
    await page.waitForTimeout(2500);
  };
  const configure = async () => {
    await page.getByRole('button', { name: `${parts} parti`, exact: true }).click();
    await page.getByText('Impostazioni export (opzionale: formato, qualità, destinazione)', { exact: true }).click();
    await page.getByRole('combobox', { name: /Formato/ }).selectOption('mp3');
  };
  const startExport = async () => {
    await page.getByRole('button', { name: /^Taglia e scarica \d+ parti/ }).first().click();
    await page.waitForFunction(() => /Creo \d+ parti/.test(document.body.innerText), null, { timeout: 60000 });
  };
  const waitDone = async (timeout = 600000) => {
    await page.waitForFunction(
      () => /Fatto in|Esportazione non completata|Export annullato/.test(document.body.innerText) && !document.querySelector('.exportbar'),
      null,
      { timeout },
    );
    const body = await text();
    return (body.match(/Fatto in[^\n]*/) || body.match(/Esportazione non completata[^\n]*/) || [''])[0];
  };
  const waitChips = (count) => page.waitForFunction((n) => document.querySelectorAll('.part-chip-done').length >= n, count, { timeout: 600000 });
  const lastZip = async () => {
    const base64 = await page.evaluate(async () => {
      const last = [...window.__downloads].reverse().find((item) => /\.zip$/i.test(item.name));
      if (!last) return null;
      const bytes = new Uint8Array(await (await fetch(last.url)).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    });
    if (!base64) return [];
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(Buffer.from(base64, 'base64'))));
    const entries = (await reader.getEntries()).map((entry) => ({ name: entry.filename, size: entry.uncompressedSize, crc: entry.signature }));
    await reader.close();
    return entries;
  };
  const resumeAndCompare = async () => {
    await startExport();
    let skipped = 0;
    const timer = setInterval(() => { chips().then((c) => { skipped = Math.max(skipped, c.skipped); }).catch(() => {}); }, 200);
    check('resumed', await waitDone());
    clearInterval(timer);
    check('skippedParts', skipped);
    const resumed = await lastZip();
    // Export completo di riferimento DOPO la ripresa (la velocità misurata ora è alta e
    // abbasserebbe la stima sotto la soglia di salvataggio per l'export interrotto).
    await startExport();
    check('reference', await waitDone());
    const reference = await lastZip();
    check('entries', resumed.map((entry) => `${entry.name}:${entry.size}`));
    const identical = resumed.length === parts && resumed.length === reference.length
      && resumed.every((entry, index) => entry.size === reference[index].size && entry.crc === reference[index].crc);
    check('identicalToReference', identical);
    return /Fatto in/.test(result.checks.resumed) && skipped >= 2 && identical;
  };

  try {
    await page.goto(url);
    await loadFile();
    await configure();
    if (scen === 'kill' || scen === 'reload') {
      await startExport();
      await waitChips(2);
      if (scen === 'kill') {
        const pids = rendererPids(engine);
        check('killedRenderers', pids.length);
        for (const pid of pids) process.kill(pid, 'SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        page = await context.newPage();
        wire(page);
        await page.goto(url);
      } else {
        await page.reload();
      }
      await page.waitForFunction(() => /Export interrotto: puoi riprenderlo/.test(document.body.innerText), null, { timeout: 60000 });
      await loadFile();
      check('restored', /Export ripristinato/.test(await text()));
      result.ok = result.checks.restored && await resumeAndCompare();
    } else if (scen === 'crash') {
      await startExport();
      await waitChips(2);
      const worker = page.workers().find((item) => /ffmpeg/i.test(item.url()));
      await worker.evaluate(() => self.close());
      check('failure', await waitDone(240000));
      check('keptNote', /restano salvate|resta salvata/.test(await text()));
      await startExport();
      let skipped = 0;
      const timer = setInterval(() => { chips().then((c) => { skipped = Math.max(skipped, c.skipped); }).catch(() => {}); }, 200);
      check('resumed', await waitDone());
      clearInterval(timer);
      check('skippedParts', skipped);
      check('entries', (await lastZip()).length);
      result.ok = result.checks.keptNote && /Fatto in/.test(result.checks.resumed) && skipped >= 2 && result.checks.entries === parts;
    } else if (scen === 'freeze') {
      const started = Date.now();
      await startExport();
      await waitChips(1);
      await page.evaluate(() => window.__setHidden(true));
      const pids = rendererPids(engine);
      for (const pid of pids) process.kill(pid, 'SIGSTOP');
      await new Promise((resolve) => setTimeout(resolve, FREEZE_MS));
      for (const pid of pids) process.kill(pid, 'SIGCONT');
      await page.evaluate(() => window.__setHidden(false));
      await page.waitForTimeout(800);
      check('resumedNotice', /Elaborazione ripresa/.test(await text()));
      check('status', await waitDone());
      check('wallMs', Date.now() - started);
      result.ok = /Fatto in/.test(result.checks.status) && result.checks.wallMs > FREEZE_MS;
    } else if (scen === 'idle') {
      await startExport();
      check('first', await waitDone());
      const before = workers.length;
      await page.evaluate(() => window.__setHidden(true));
      await page.waitForTimeout(1500);
      check('engineReleased', workers.slice(before).includes('closed'));
      await page.evaluate(() => window.__setHidden(false));
      await startExport();
      check('second', await waitDone());
      result.ok = result.checks.engineReleased && /Fatto in/.test(result.checks.second);
    } else if (scen === 'delivery' && !android) {
      result.ok = true;
      result.skipped = 'solo Android (file singoli)';
    } else if (scen === 'delivery') {
      await startExport();
      await waitChips(1);
      await page.waitForTimeout(500);
      const first = downloads.length;
      await page.reload();
      await page.waitForFunction(() => /Export interrotto: puoi riprenderlo/.test(document.body.innerText), null, { timeout: 60000 });
      await loadFile();
      const before = downloads.length;
      await startExport();
      check('resumed', await waitDone());
      await page.waitForTimeout(1000);
      check('downloadsBefore', first);
      check('downloadsAfter', downloads.length - before);
      result.ok = /Fatto in/.test(result.checks.resumed) && first >= 1 && downloads.length - before === parts - first;
    } else {
      throw new Error(`Scenario sconosciuto: ${scen}`);
    }
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 300);
  } finally {
    result.pageErrors = errors;
    await (browser ? browser.close() : context.close()).catch(() => {});
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  }
  return result;
}

const audioPath = noiseWav();
const results = [];
for (const profile of profiles) {
  for (const scen of scenarios) {
    const result = await runScenario(profile, scen, audioPath);
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenari superati.`);
process.exitCode = failed.length ? 1 : 0;
