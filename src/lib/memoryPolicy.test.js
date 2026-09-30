import test from 'node:test';
import assert from 'node:assert/strict';
import { outputMemoryPolicy, assertOutputBudget, mountAudioInput, readAudioOutput, MIN_PART_BYTES } from './memoryPolicy.js';

const MB = 1000 * 1000;
const MiB = 1024 * 1024;
const mobile = { navigator: { userAgent: 'iPhone', hardwareConcurrency: 4 } };
const desktop = { navigator: { deviceMemory: 8, hardwareConcurrency: 8 } };

// Profili reali: il limite dipende solo dalla RAM dichiarata, non dal tipo di dispositivo.
const PROFILES = {
  'telefono Android 4 GB': { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)', deviceMemory: 4, hardwareConcurrency: 8 } },
  'tablet Android 3 GB': { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X200)', deviceMemory: 2, hardwareConcurrency: 8 } },
  'tablet Android 8 GB': { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710)', deviceMemory: 8, hardwareConcurrency: 8 } },
  'telefono economico 1 GB': { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10)', deviceMemory: 1, hardwareConcurrency: 4 } },
  iPad: { navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 } },
  iPhone: mobile,
  'desktop 8 GB': desktop,
  'desktop 4 GB / 4 core': { navigator: { deviceMemory: 4, hardwareConcurrency: 4 } },
  'desktop senza deviceMemory (Firefox/Safari)': { navigator: { userAgent: 'Mozilla/5.0 Firefox/140.0' } },
};

test('every device accepts parts of at least 100 MB', () => {
  assert.ok(MIN_PART_BYTES >= 100 * MiB);
  for (const [name, env] of Object.entries(PROFILES)) {
    const policy = outputMemoryPolicy(env);
    assert.ok(policy.segmentBytes >= MIN_PART_BYTES, `${name}: ${policy.segmentBytes}`);
    assert.doesNotThrow(() => assertOutputBudget(100 * MB, env), name);
  }
});

test('a 160–180 MB recording split in two parts exports on every device', () => {
  for (const [name, env] of Object.entries(PROFILES)) {
    for (const total of [160 * MB, 180 * MB]) {
      assert.doesNotThrow(() => assertOutputBudget(total / 2, env, { totalBytes: total }), `${name} ${total}`);
    }
    const policy = outputMemoryPolicy(env);
    // iPhone/iPad ricevono un unico ZIP in memoria: deve contenere l'intera registrazione.
    assert.ok(policy.archiveBytes >= 180 * MB * 1.15, `${name}: zip ${policy.archiveBytes}`);
    // Le parti restano riscaricabili (download multiplo bloccato → pulsante "Scarica").
    assert.ok(policy.retainBytes >= 180 * MB, `${name}: retain ${policy.retainBytes}`);
  }
});

test('limits depend on declared memory, never on phone/tablet/desktop form factor', () => {
  for (const memory of [1, 2, 4, 8]) {
    const touch = outputMemoryPolicy({ navigator: { userAgent: 'Android', deviceMemory: memory, hardwareConcurrency: 8 } });
    const pc = outputMemoryPolicy({ navigator: { deviceMemory: memory, hardwareConcurrency: 8 } });
    assert.deepEqual(touch, pc, `deviceMemory ${memory}`);
  }
  assert.deepEqual(outputMemoryPolicy(PROFILES.iPad), outputMemoryPolicy(PROFILES['desktop senza deviceMemory (Firefox/Safari)']));
  assert.ok(outputMemoryPolicy({ navigator: { deviceMemory: 2 } }).segmentBytes < outputMemoryPolicy(desktop).segmentBytes);
});

test('oversized parts are refused with an actionable number of parts', () => {
  assert.throws(() => assertOutputBudget(500 * MiB, mobile), /parti|M4A/);
  assert.throws(
    () => assertOutputBudget(600 * MB, mobile, { totalBytes: 1200 * MB }),
    (error) => /almeno (\d+) parti/.test(error.message) && Number(/almeno (\d+) parti/.exec(error.message)[1]) >= 5,
  );
  // Due parti bastano in totale ma una è sbilanciata: spostare i tagli, non aggiungerne.
  assert.throws(
    () => assertOutputBudget(171 * MB, PROFILES['tablet Android 3 GB'], { totalBytes: 180 * MB, partCount: 2 }),
    /Sposta i tagli/,
  );
  assert.throws(
    () => assertOutputBudget(180 * MB, PROFILES['tablet Android 3 GB'], { totalBytes: 360 * MB, partCount: 2 }),
    /almeno 3 parti/,
  );
  assert.doesNotThrow(() => assertOutputBudget(120 * MB, PROFILES['tablet Android 3 GB'], { totalBytes: 360 * MB, partCount: 3 }));
  assert.throws(() => assertOutputBudget(Number.NaN, desktop), /limite/);
});

test('WORKERFS mount of a 500 MiB input never reads the full blob', async () => {
  const blob = { size: 500 * MiB, arrayBuffer() { throw Error('full read'); } };
  const calls = [];
  const ffmpeg = { createDir: async () => {}, mount: async (...a) => { calls.push(a); return true; } };
  const mounted = await mountAudioInput(ffmpeg, { blob, extension: '.wav' }, 1, mobile);
  assert.equal(mounted.memfs, false);
  assert.equal(calls[0][1].blobs[0].data, blob);
});

test('unavailable WORKERFS fails before reading a large input', async () => {
  let reads = 0;
  const blob = { size: 500 * MiB, arrayBuffer: async () => { reads++; return new ArrayBuffer(1); } };
  const ffmpeg = { createDir: async () => {}, mount: async () => false, deleteDir: async () => {} };
  await assert.rejects(mountAudioInput(ffmpeg, { blob }, 2, mobile), /WORKERFS|copia integrale/);
  assert.equal(reads, 0);
});

test('unavailable WORKERFS still copies a normal 50 MB lecture on a tablet', async () => {
  const blob = { size: 50 * MB, arrayBuffer: async () => new ArrayBuffer(8) };
  const written = [];
  const ffmpeg = { createDir: async () => {}, mount: async () => false, deleteDir: async () => {}, writeFile: async (path) => written.push(path) };
  const mounted = await mountAudioInput(ffmpeg, { blob, extension: '.m4a' }, 3, PROFILES.iPad);
  assert.equal(mounted.memfs, true);
  assert.deepEqual(written, ['/input-3.m4a']);
});

test('terminated worker does not trigger a full-file fallback', async () => {
  let reads = 0;
  const blob = { size: 1, arrayBuffer: async () => { reads++; } };
  const ffmpeg = { loaded: false, createDir: async () => { throw Error('terminated'); }, deleteDir: async () => {} };
  await assert.rejects(mountAudioInput(ffmpeg, { blob }, 3), /terminated/);
  assert.equal(reads, 0);
});

test('a limited output is deleted and never returned as a successful file', async () => {
  const deleted = [];
  const ffmpeg = { readFile: async () => new Uint8Array(16), deleteFile: async (path) => deleted.push(path) };
  await assert.rejects(readAudioOutput(ffmpeg, 'out.wav', 16), /limite/);
  assert.deepEqual(deleted, ['out.wav']);
});

test('successful output is also removed before returning transferred bytes', async () => {
  const bytes = new Uint8Array(4);
  let deleted = false;
  assert.equal(await readAudioOutput({ readFile: async () => bytes, deleteFile: async () => { deleted = true; } }, 'out', 16), bytes);
  assert.equal(deleted, true);
});
