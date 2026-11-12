import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncodeAhead, exportEngineCount } from './parallelExport.js';

const MiB = 1024 * 1024;
const GALAXY_TAB_S8 = {
  navigator: {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    deviceMemory: 8,
    hardwareConcurrency: 8,
    connection: { saveData: false },
  },
};
const withNav = (patch) => ({ navigator: { ...GALAXY_TAB_S8.navigator, ...patch } });
const conversion = { fastCopy: false, formatId: 'm4a', pendingParts: 2, maxPartBytes: 60 * MiB, segmentBudgetBytes: 512 * MiB, destMode: 'singles' };

test('exportEngineCount: 2 motori su Android 8 GB / 8 core per conversioni compresse', () => {
  assert.equal(exportEngineCount(conversion, GALAXY_TAB_S8), 2);
  assert.equal(exportEngineCount({ ...conversion, formatId: 'mp3', destMode: 'zip-classic', pendingParts: 6 }, GALAXY_TAB_S8), 2);
  assert.equal(exportEngineCount({ ...conversion, formatId: 'ogg' }, GALAXY_TAB_S8), 2);
});

test('exportEngineCount: taglio senza ricodifica, formati grandi o una sola parte restano sequenziali', () => {
  assert.equal(exportEngineCount({ ...conversion, fastCopy: true }, GALAXY_TAB_S8), 1);
  assert.equal(exportEngineCount({ ...conversion, formatId: 'wav' }, GALAXY_TAB_S8), 1);
  assert.equal(exportEngineCount({ ...conversion, formatId: 'flac' }, GALAXY_TAB_S8), 1);
  assert.equal(exportEngineCount({ ...conversion, pendingParts: 1 }, GALAXY_TAB_S8), 1);
  assert.equal(exportEngineCount({ ...conversion, pendingParts: 0 }, GALAXY_TAB_S8), 1);
  assert.equal(exportEngineCount({ ...conversion, destMode: 'folder' }, GALAXY_TAB_S8), 1);
});

test('exportEngineCount: desktop, iPad, Android con meno memoria/core o risparmio dati restano sequenziali', () => {
  const desktop = { navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/151.0.0.0', deviceMemory: 8, hardwareConcurrency: 12 } };
  const ipad = { navigator: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', hardwareConcurrency: 8, maxTouchPoints: 5 } };
  assert.equal(exportEngineCount(conversion, desktop), 1);
  assert.equal(exportEngineCount(conversion, ipad), 1);
  assert.equal(exportEngineCount(conversion, withNav({ deviceMemory: 4 })), 1);
  assert.equal(exportEngineCount(conversion, withNav({ deviceMemory: undefined })), 1);
  assert.equal(exportEngineCount(conversion, withNav({ hardwareConcurrency: 6 })), 1);
  assert.equal(exportEngineCount(conversion, withNav({ connection: { saveData: true } })), 1);
  assert.equal(exportEngineCount(conversion, {}), 1);
});

test('exportEngineCount: due uscite devono stare nel budget di una parte', () => {
  assert.equal(exportEngineCount({ ...conversion, maxPartBytes: 256 * MiB }, GALAXY_TAB_S8), 2);
  assert.equal(exportEngineCount({ ...conversion, maxPartBytes: 257 * MiB }, GALAXY_TAB_S8), 1);
  assert.equal(exportEngineCount({ ...conversion, maxPartBytes: Number.NaN }, GALAXY_TAB_S8), 1);
  assert.equal(exportEngineCount({ ...conversion, segmentBudgetBytes: 0 }, GALAXY_TAB_S8), 1);
});

// Motore finto: ogni encode resta in attesa finché il test non lo completa.
function fakeLanes() {
  const calls = [];
  const running = new Set();
  let maxRunning = 0;
  const encode = (lane, index) => new Promise((resolve, reject) => {
    const call = { lane: lane.id, index, resolve: (value = `${lane.id}:${index}`) => { running.delete(call); resolve(value); }, reject: (error) => { running.delete(call); reject(error); } };
    calls.push(call);
    running.add(call);
    maxRunning = Math.max(maxRunning, running.size);
  });
  const find = (index, lane) => calls.find((call) => call.index === index && (!lane || call.lane === lane) && running.has(call));
  return { calls, encode, find, running, max: () => maxRunning };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('createEncodeAhead: con un solo motore lavora in ordine, una parte alla volta', async () => {
  const fake = fakeLanes();
  const queue = createEncodeAhead({ plan: [0, 1, 2], encode: fake.encode });
  queue.addLane({ id: 'main', main: true });
  for (const index of [0, 1, 2]) {
    const pending = queue.take(index);
    await tick();
    assert.equal(fake.running.size, 1);
    fake.find(index, 'main').resolve();
    assert.equal(await pending, `main:${index}`);
  }
  assert.deepEqual(fake.calls.map((call) => call.index), [0, 1, 2]);
  assert.equal(fake.max(), 1);
  assert.equal(queue.usedParallel(), false);
});

test('createEncodeAhead: con due motori prepara la parte successiva ma mai più di due', async () => {
  const fake = fakeLanes();
  const started = [];
  const queue = createEncodeAhead({ plan: [0, 1, 2, 3], encode: fake.encode, onStart: (index, lane) => started.push(`${lane.id}:${index}`) });
  queue.addLane({ id: 'main', main: true });
  queue.addLane({ id: 'helper', main: false });
  const first = queue.take(0);
  await tick();
  assert.deepEqual(started, ['main:0', 'helper:1']);
  // la parte 1 finisce prima della 0: nessun nuovo lavoro finché la 0 non è consegnata
  fake.find(1, 'helper').resolve();
  await tick();
  assert.equal(fake.running.size, 1);
  fake.find(0, 'main').resolve();
  assert.equal(await first, 'main:0');
  await tick();
  assert.equal(fake.calls.length, 2, 'la 2 parte solo quando si chiede la 1 (memoria: max 2 uscite vive)');
  assert.equal(await queue.take(1), 'helper:1');
  await tick();
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[2].index, 2);
  const third = queue.take(2);
  await tick();
  assert.equal(fake.calls.length, 4);
  fake.find(2).resolve();
  fake.find(3).resolve();
  assert.match(await third, /:2$/);
  assert.match(await queue.take(3), /:3$/);
  assert.equal(fake.max(), 2);
  assert.equal(queue.usedParallel(), true);
});

test('createEncodeAhead: se il motore aggiuntivo fallisce la parte si rifà sul principale', async () => {
  const fake = fakeLanes();
  let killed = 0;
  const queue = createEncodeAhead({ plan: [0, 1, 2], encode: fake.encode });
  queue.addLane({ id: 'main', main: true });
  queue.addLane({ id: 'helper', main: false, kill: () => { killed += 1; } });
  const first = queue.take(0);
  await tick();
  fake.find(1, 'helper').reject(new Error('worker morto'));
  fake.find(0, 'main').resolve();
  assert.equal(await first, 'main:0');
  const second = queue.take(1);
  await tick();
  assert.equal(killed, 1);
  assert.equal(queue.laneCount(), 1);
  fake.find(1, 'main').resolve();
  assert.equal(await second, 'main:1');
  const third = queue.take(2);
  await tick();
  assert.equal(fake.find(2).lane, 'main');
  fake.find(2).resolve();
  assert.equal(await third, 'main:2');
});

test('createEncodeAhead: un errore del motore principale arriva a chi consegna, senza ripetere', async () => {
  const fake = fakeLanes();
  const queue = createEncodeAhead({ plan: [0, 1], encode: fake.encode });
  queue.addLane({ id: 'main', main: true });
  queue.addLane({ id: 'helper', main: false });
  const first = queue.take(0);
  await tick();
  fake.find(0, 'main').reject(Object.assign(new Error('OOM'), { code: 'crash' }));
  await assert.rejects(first, /OOM/);
  assert.equal(fake.calls.filter((call) => call.index === 0).length, 1);
  assert.equal(queue.mainBusy(), false);
  queue.dispose();
});

test('createEncodeAhead: annullato, un errore del motore aggiuntivo non viene ripetuto', async () => {
  const fake = fakeLanes();
  let aborted = false;
  const queue = createEncodeAhead({ plan: [0, 1], encode: fake.encode, isAborted: () => aborted });
  queue.addLane({ id: 'main', main: true });
  queue.addLane({ id: 'helper', main: false });
  const first = queue.take(0);
  await tick();
  aborted = true;
  fake.find(1, 'helper').reject(new Error('terminato'));
  fake.find(0, 'main').reject(new Error('terminato'));
  await assert.rejects(first, /terminato/);
  await assert.rejects(queue.take(1), /terminato/);
  assert.equal(fake.calls.length, 2);
});

test('createEncodeAhead: un motore che arriva dopo inizia subito la parte successiva', async () => {
  const fake = fakeLanes();
  const queue = createEncodeAhead({ plan: [0, 1, 2], encode: fake.encode });
  queue.addLane({ id: 'main', main: true });
  const first = queue.take(0);
  await tick();
  assert.equal(fake.calls.length, 1);
  queue.addLane({ id: 'helper', main: false });
  await tick();
  assert.equal(fake.find(1)?.lane, 'helper');
  fake.find(0).resolve();
  fake.find(1).resolve();
  assert.equal(await first, 'main:0');
  assert.equal(await queue.take(1), 'helper:1');
});

test('createEncodeAhead: una parte fuori piano viene creata su richiesta', async () => {
  const fake = fakeLanes();
  const queue = createEncodeAhead({ plan: [0, 2], encode: fake.encode });
  queue.addLane({ id: 'main', main: true });
  queue.addLane({ id: 'helper', main: false });
  const zero = queue.take(0);
  await tick();
  fake.find(0).resolve();
  fake.find(2).resolve();
  await zero;
  const one = queue.take(1);
  await tick();
  assert.ok(fake.find(1));
  fake.find(1).resolve();
  assert.match(await one, /:1$/);
  assert.match(await queue.take(2), /:2$/);
});

test('createEncodeAhead: le parti preparate e mai consegnate non lasciano rifiuti non gestiti', async () => {
  const fake = fakeLanes();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const queue = createEncodeAhead({ plan: [0, 1], encode: fake.encode });
    queue.addLane({ id: 'main', main: true });
    queue.addLane({ id: 'helper', main: false });
    const first = queue.take(0);
    await tick();
    fake.find(0).resolve();
    await first;
    queue.dispose();
    fake.find(1).reject(new Error('dopo la chiusura'));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
    assert.equal(fake.calls.length, 2, 'nessuna ripetizione dopo dispose');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('createEncodeAhead: senza motori la richiesta fallisce in modo esplicito', async () => {
  const queue = createEncodeAhead({ plan: [0], encode: async () => 'x' });
  await assert.rejects(queue.take(0), /Nessun motore/);
  queue.addLane({ id: 'main', main: true });
  queue.dispose();
  await assert.rejects(queue.take(0), /chiusa/);
});

test('createEncodeAhead: un motore aggiunto a coda già chiusa viene chiuso subito', () => {
  const queue = createEncodeAhead({ plan: [0, 1], encode: async () => 'x' });
  queue.addLane({ id: 'main', main: true });
  queue.dispose();
  let killed = 0;
  queue.addLane({ id: 'helper', main: false, kill: () => { killed += 1; } });
  assert.equal(killed, 1);
  assert.equal(queue.laneCount(), 1, 'il motore tardivo non entra nella coda');
});
