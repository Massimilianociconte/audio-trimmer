import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_MAX_AGE_MS,
  PERSIST_MIN_WORK_SECONDS,
  completedParts,
  createExportJobStore,
  exportJobFingerprint,
  exportPersistenceMode,
  hasStorageRoomFor,
  sameSource,
  sourceIdentity,
} from './exportJobs.js';

// IndexedDB asincrono minimale: richieste in coda con setImmediate, commit
// quando l'ultima richiesta si chiude (come Safari), scritture solo al commit.
function fakeIndexedDB() {
  const stores = new Map();
  const stats = { opens: 0, upgrades: 0, transactions: 0 };
  const names = (items) => ({ contains: (name) => items.includes(name) });
  const db = {
    get objectStoreNames() { return names([...stores.keys()]); },
    createObjectStore(name, { keyPath }) {
      stores.set(name, { keyPath, records: new Map() });
      return { createIndex() {} };
    },
    close() {},
    transaction(storeNames, mode) {
      stats.transactions += 1;
      const selected = typeof storeNames === 'string' ? [storeNames] : storeNames;
      const working = new Map(selected.map((name) => [name, new Map(stores.get(name).records)]));
      let active = true;
      let aborted = false;
      let pending = 0;
      const tx = {
        error: null,
        abort() {
          if (aborted) return;
          aborted = true;
          active = false;
          tx.error ??= new DOMException('Transaction aborted', 'AbortError');
          setImmediate(() => tx.onabort?.());
        },
        objectStore(name) {
          const { keyPath } = stores.get(name);
          const records = working.get(name);
          const enqueue = (operation, request = {}) => {
            if (!active) throw new DOMException('Transaction inactive', 'TransactionInactiveError');
            pending += 1;
            setImmediate(() => {
              if (aborted) return;
              pending -= 1;
              try {
                request.result = operation();
              } catch (error) {
                request.error = error;
                tx.error = error;
                request.onerror?.();
                tx.abort();
                return;
              }
              request.onsuccess?.();
              if (!pending && !aborted) {
                active = false;
                if (mode === 'readwrite') {
                  for (const [store, values] of working) stores.get(store).records = values;
                }
                setImmediate(() => tx.oncomplete?.());
              }
            });
            return request;
          };
          return {
            get: (key) => enqueue(() => structuredClone(records.get(key))),
            getAll: () => enqueue(() => [...records.values()].map((value) => structuredClone(value))),
            put: (record) => enqueue(() => {
              if (mode !== 'readwrite') throw new DOMException('Read only', 'ReadOnlyError');
              records.set(record[keyPath], record);
              return record[keyPath];
            }),
            openCursor() {
              const keys = [...records.keys()];
              let position = 0;
              const request = {};
              const read = () => {
                const key = keys[position];
                if (key === undefined) return null;
                return {
                  value: records.get(key),
                  delete: () => enqueue(() => records.delete(key)),
                  continue() {
                    position += 1;
                    enqueue(read, request);
                  },
                };
              };
              return enqueue(read, request);
            },
          };
        },
      };
      return tx;
    },
  };
  return {
    stores,
    stats,
    records: (name) => stores.get(name)?.records ?? new Map(),
    indexedDB: {
      open() {
        stats.opens += 1;
        const request = { result: db };
        setImmediate(() => {
          if (!stores.size) {
            stats.upgrades += 1;
            request.onupgradeneeded?.();
          }
          request.onsuccess?.();
        });
        return request;
      },
    },
  };
}

const SOURCE = { name: 'lezione.m4a', size: 182_000_000, lastModified: 1_700_000_000_000, duration: 5400.1234 };
const SEGMENTS = [{ start: 0, duration: 2700 }, { start: 2700, duration: 2700.1234 }];
const SETTINGS = { source: SOURCE, segments: SEGMENTS, formatId: 'm4a', bitrateKbps: 128, fastCopy: true, fadeSeconds: 0, outputExtension: '.m4a' };

function beginArgs(overrides = {}) {
  return {
    fingerprint: exportJobFingerprint(SETTINGS),
    persist: 'blobs',
    source: SOURCE,
    ui: { mode: 'equal', equalParts: 2 },
    settings: { exportFormat: 'm4a' },
    names: ['Parte 1', 'Parte 2'],
    total: 2,
    destMode: 'zip-classic',
    ...overrides,
  };
}

test('sameSource recognizes the same file after a reload and rejects others', () => {
  assert.ok(sameSource(SOURCE, { ...SOURCE, duration: 5400.15 }));
  // lastModified assente su un lato (es. registrazione ricaricata): basta il resto.
  assert.ok(sameSource(SOURCE, { ...SOURCE, lastModified: undefined }));
  assert.equal(sameSource(SOURCE, { ...SOURCE, size: SOURCE.size + 1 }), false);
  assert.equal(sameSource(SOURCE, { ...SOURCE, name: 'altro.m4a' }), false);
  assert.equal(sameSource(SOURCE, { ...SOURCE, lastModified: 1 }), false);
  assert.equal(sameSource(SOURCE, { ...SOURCE, duration: 5401 }), false);
  assert.equal(sameSource({ name: 'x', size: 0, duration: 1 }, { name: 'x', size: 0, duration: 1 }), false);
  assert.equal(sameSource(null, SOURCE), false);
  assert.deepEqual(sourceIdentity(SOURCE), { name: 'lezione.m4a', size: 182_000_000, lastModified: 1_700_000_000_000, duration: 5400.123 });
});

test('fingerprint changes with cuts or audio settings, not with ignored fields', () => {
  const base = exportJobFingerprint(SETTINGS);
  assert.equal(exportJobFingerprint({ ...SETTINGS }), base);
  // In copia veloce bitrate e dissolvenza non influiscono sull'uscita.
  assert.equal(exportJobFingerprint({ ...SETTINGS, bitrateKbps: 320, fadeSeconds: 2 }), base);
  assert.notEqual(exportJobFingerprint({ ...SETTINGS, segments: [{ start: 0, duration: 2000 }, { start: 2000, duration: 3400 }] }), base);
  assert.notEqual(exportJobFingerprint({ ...SETTINGS, formatId: 'mp3', outputExtension: '.mp3' }), base);
  const encoded = { ...SETTINGS, fastCopy: false };
  assert.notEqual(exportJobFingerprint(encoded), exportJobFingerprint({ ...encoded, bitrateKbps: 192 }));
  assert.notEqual(exportJobFingerprint(encoded), exportJobFingerprint({ ...encoded, fadeSeconds: 1 }));
  assert.notEqual(exportJobFingerprint(encoded), base);
});

test('persistence only on mobile, for in-memory ZIP jobs worth saving and for single files', () => {
  assert.equal(exportPersistenceMode({ mobile: false, destMode: 'zip-classic', estimatedWorkSeconds: 600 }), null);
  assert.equal(exportPersistenceMode({ mobile: false, destMode: 'singles', estimatedWorkSeconds: 600 }), null);
  assert.equal(exportPersistenceMode({ mobile: true, destMode: 'singles', estimatedWorkSeconds: 1 }), 'delivery');
  assert.equal(exportPersistenceMode({ mobile: true, destMode: 'zip-classic', estimatedWorkSeconds: PERSIST_MIN_WORK_SECONDS - 1 }), null);
  assert.equal(exportPersistenceMode({ mobile: true, destMode: 'zip-classic', estimatedWorkSeconds: PERSIST_MIN_WORK_SECONDS }), 'blobs');
  assert.equal(exportPersistenceMode({ mobile: true, destMode: 'folder', estimatedWorkSeconds: 600 }), null);
  assert.equal(exportPersistenceMode({ mobile: true, destMode: 'zip-stream', estimatedWorkSeconds: 600 }), null);
});

test('storage room check keeps a margin and never blocks without an estimate', async () => {
  const MiB = 1024 * 1024;
  assert.equal(await hasStorageRoomFor(100 * MiB, undefined), true);
  assert.equal(await hasStorageRoomFor(100 * MiB, { estimate: async () => ({}) }), true);
  assert.equal(await hasStorageRoomFor(100 * MiB, { estimate: async () => { throw new Error('denied'); } }), true);
  assert.equal(await hasStorageRoomFor(100 * MiB, { estimate: async () => ({ quota: 1000 * MiB, usage: 0 }) }), true);
  assert.equal(await hasStorageRoomFor(100 * MiB, { estimate: async () => ({ quota: 150 * MiB, usage: 0 }) }), false);
});

test('parts saved during an export are reused by a retry with the same cuts', async () => {
  const fixture = fakeIndexedDB();
  let clock = 1000;
  const store = createExportJobStore({ indexedDB: fixture.indexedDB, now: () => clock });
  const job = await store.begin(beginArgs());
  assert.ok(job?.id);
  assert.deepEqual(completedParts(job), []);

  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' });
  clock += 10;
  assert.equal(await store.savePart(job.id, 0, { blob, name: 'Parte 1.m4a', size: 3, duration: 2700 }), true);

  const resumed = await store.begin(beginArgs({ names: ['Intro', 'Parte 2'] }));
  assert.equal(resumed.id, job.id);
  assert.deepEqual(resumed.names, ['Intro', 'Parte 2']);
  assert.deepEqual(completedParts(resumed), [
    { index: 0, name: 'Parte 1.m4a', size: 3, duration: 2700, stored: true, delivered: false },
  ]);
  const loaded = await store.loadPart(job.id, 0);
  assert.ok(loaded instanceof Blob);
  assert.deepEqual(new Uint8Array(await loaded.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(await store.loadPart(job.id, 1), null);

  const pending = await store.getPending();
  assert.equal(pending.id, job.id);
});

test('a different job replaces the old one and its stored parts', async () => {
  const fixture = fakeIndexedDB();
  const store = createExportJobStore({ indexedDB: fixture.indexedDB, now: () => 5000 });
  const first = await store.begin(beginArgs());
  await store.savePart(first.id, 0, { blob: new Blob([new Uint8Array(8)]), name: 'a', size: 8, duration: 1 });
  assert.equal(fixture.records('parts').size, 1);

  const otherCuts = exportJobFingerprint({ ...SETTINGS, segments: [{ start: 0, duration: 100 }] });
  const second = await store.begin(beginArgs({ fingerprint: otherCuts }));
  assert.notEqual(second.id, first.id);
  assert.equal(fixture.records('jobs').size, 1);
  assert.equal(fixture.records('parts').size, 0);
  assert.equal(await store.loadPart(first.id, 0), null);

  // Stessa impronta ma modalità diversa (ZIP → file singoli): job nuovo.
  const singles = await store.begin(beginArgs({ fingerprint: otherCuts, persist: 'delivery', destMode: 'singles' }));
  assert.notEqual(singles.id, second.id);
  assert.equal(await store.savePart(singles.id, 1, { name: 'b', size: 5, duration: 2, delivered: true }), true);
  const pending = await store.getPending();
  assert.deepEqual(completedParts(pending), [{ index: 1, name: 'b', size: 5, duration: 2, stored: false, delivered: true }]);
});

test('saving a part of a discarded job stores nothing', async () => {
  const fixture = fakeIndexedDB();
  const store = createExportJobStore({ indexedDB: fixture.indexedDB });
  const job = await store.begin(beginArgs());
  assert.equal(await store.discard(), true);
  assert.equal(await store.savePart(job.id, 0, { blob: new Blob([new Uint8Array(4)]), name: 'a', size: 4, duration: 1 }), false);
  assert.equal(fixture.records('parts').size, 0);
  assert.equal(fixture.records('jobs').size, 0);
  assert.equal(await store.getPending(), null);
});

test('expired jobs are not offered and are cleaned up', async () => {
  const fixture = fakeIndexedDB();
  let clock = 0;
  const store = createExportJobStore({ indexedDB: fixture.indexedDB, now: () => clock });
  const job = await store.begin(beginArgs());
  await store.savePart(job.id, 0, { blob: new Blob([new Uint8Array(4)]), name: 'a', size: 4, duration: 1 });
  clock = JOB_MAX_AGE_MS + 1;
  assert.equal(await store.getPending(), null);
  assert.equal(fixture.records('jobs').size, 0);
  assert.equal(fixture.records('parts').size, 0);
  // Un job scaduto non viene neppure riusato da un nuovo export identico.
  const fresh = await store.begin(beginArgs());
  assert.notEqual(fresh.id, job.id);
});

test('without IndexedDB every operation degrades to "not saved" without throwing', async () => {
  const store = createExportJobStore({ indexedDB: undefined });
  assert.equal(await store.getPending(), null);
  assert.equal(await store.begin(beginArgs()), null);
  assert.equal(await store.loadPart('x', 0), null);
  assert.equal(await store.savePart('x', 0, { name: 'a', size: 1, duration: 1 }), false);
  assert.equal(await store.discard(), false);
});

test('a database that never answers times out instead of blocking the export', async () => {
  let opens = 0;
  const stuck = { open() { opens += 1; return {}; } };
  const store = createExportJobStore({ indexedDB: stuck, timeoutMs: 20 });
  const started = Date.now();
  assert.equal(await store.begin(beginArgs()), null);
  assert.ok(Date.now() - started < 2000);
  // La connessione bloccata viene abbandonata: l'operazione successiva riapre.
  assert.equal(await store.getPending(), null);
  assert.equal(opens, 2);
});

test('a database that fails to open is retried on the next operation', async () => {
  const fixture = fakeIndexedDB();
  let failNext = true;
  const flaky = {
    open(...args) {
      if (failNext) {
        failNext = false;
        const request = { error: new DOMException('Busy', 'UnknownError') };
        setImmediate(() => request.onerror?.());
        return request;
      }
      return fixture.indexedDB.open(...args);
    },
  };
  const store = createExportJobStore({ indexedDB: flaky });
  assert.equal(await store.begin(beginArgs()), null);
  const job = await store.begin(beginArgs());
  assert.ok(job?.id);
});

test('completedParts sorts by index and ignores invalid entries', () => {
  assert.deepEqual(completedParts(null), []);
  assert.deepEqual(
    completedParts({ done: { 2: { name: 'c' }, 0: { name: 'a' }, x: { name: 'bad' } } }).map((part) => part.index),
    [0, 2],
  );
});
