import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from './storage.js';
const { listProjects, loadProject } = storage;

// Async IndexedDB boundary adapter: commits when the final request callback
// returns, before Promise continuations (the stricter Safari lifetime).
// Writes stay staged until commit so migration failures can test atomicity.
function databaseFixture({ legacy = [], meta = [], audio = [], failAudioId } = {}) {
  const stores = new Map([
    ['projects', new Map(legacy.map((record) => [record.id, record]))],
    ['projectMeta', new Map(meta.map((record) => [record.id, record]))],
    ['projectAudio', new Map(audio.map((record) => [record.id, record]))],
  ]);
  const stats = { legacyBulkReads: 0, audioReads: 0, audioWrites: 0, closed: 0 };
  const names = (items) => ({ contains: (name) => items.includes(name) });
  const db = {
    objectStoreNames: names([...stores.keys()]),
    close() { stats.closed += 1; },
    transaction(storeNames, mode) {
      const selected = typeof storeNames === 'string' ? [storeNames] : storeNames;
      const working = new Map(selected.map((name) => [name, new Map(stores.get(name))]));
      let active = true;
      let aborted = false;
      let pending = 0;
      const tx = {
        objectStoreNames: names(selected),
        abort() {
          if (aborted) return;
          aborted = true;
          active = false;
          tx.error ??= new Error('Transaction aborted');
          setImmediate(() => tx.onabort?.());
        },
        objectStore(name) {
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
                  for (const [store, values] of working) stores.set(store, values);
                }
                setImmediate(() => tx.oncomplete?.());
              }
            });
            return request;
          };
          return {
            count: () => enqueue(() => records.size),
            get: (id) => enqueue(() => {
              if (name === 'projectAudio') stats.audioReads += 1;
              return records.get(id);
            }),
            getAll: () => enqueue(() => {
              if (name === 'projects') stats.legacyBulkReads += 1;
              return [...records.values()];
            }),
            put: (record) => enqueue(() => {
              if (name === 'projectAudio') stats.audioWrites += 1;
              if (name === 'projectAudio' && record.id === failAudioId) {
                throw new DOMException('Storage full', 'QuotaExceededError');
              }
              records.set(record.id, record);
              return record.id;
            }),
            delete: (id) => enqueue(() => records.delete(id)),
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
    indexedDB: {
      open() {
        const request = { result: db };
        setImmediate(() => request.onsuccess?.());
        return request;
      },
    },
  };
}

async function withDatabase(fixture, work) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fixture.indexedDB });
  try {
    return await work();
  } finally {
    if (original) Object.defineProperty(globalThis, 'indexedDB', original);
    else delete globalThis.indexedDB;
  }
}

test('legacy migration lists projects without materializing the full audio library', async () => {
  const blob = new Blob(['audio'], { type: 'audio/mpeg' });
  const fixture = databaseFixture({ legacy: [
    { id: 'one', name: 'Lesson', updatedAt: 10, audioBlob: blob, customCuts: [{ position: 2 }], bookmarks: [] },
    { id: 'two', name: 'Empty', updatedAt: 20, size: 9, bookmarks: [{ position: 1 }] },
  ] });
  await withDatabase(fixture, async () => {
    const projects = await listProjects();
    assert.equal(fixture.stats.legacyBulkReads, 0);
    assert.deepEqual(projects.map(({ id, size, cutsCount, bookmarksCount }) => ({ id, size, cutsCount, bookmarksCount })), [
      { id: 'two', size: 9, cutsCount: 0, bookmarksCount: 1 },
      { id: 'one', size: 5, cutsCount: 1, bookmarksCount: 0 },
    ]);
    assert.equal(fixture.stores.get('projects').size, 0);
    assert.equal(fixture.stores.get('projectAudio').get('one').blob, blob);
    assert.equal(fixture.stores.get('projectMeta').get('one').audioBlob, undefined);
  });
});

test('failed migration preserves legacy audio and rolls back migrated records', async () => {
  const records = ['one', 'two'].map((id) => ({ id, audioBlob: new Blob([id]) }));
  const fixture = databaseFixture({ legacy: records, failAudioId: 'two' });
  await withDatabase(fixture, async () => {
    await assert.rejects(listProjects(), { name: 'QuotaExceededError' });
    assert.deepEqual([...fixture.stores.get('projects').keys()], ['one', 'two']);
    assert.equal(fixture.stores.get('projectMeta').size, 0);
    assert.equal(fixture.stores.get('projectAudio').size, 0);
    assert.equal(fixture.stats.closed, 1);
  });
});

test('loadProject queues audio before the metadata request auto-commits', async () => {
  const blob = new Blob(['lesson']);
  const fixture = databaseFixture({
    meta: [{ id: 'one', name: 'Lesson', duration: 12 }],
    audio: [{ id: 'one', blob }],
  });
  await withDatabase(fixture, async () => {
    assert.deepEqual(await loadProject('one'), { id: 'one', name: 'Lesson', duration: 12, audioBlob: blob });
    assert.equal(await loadProject('missing'), null);
  });
});

test('renaming updates metadata without reading or rewriting the audio', async () => {
  const blob = new Blob(['lesson']);
  const fixture = databaseFixture({
    meta: [{ id: 'one', name: 'Lesson', duration: 12, createdAt: 5, updatedAt: 5, customCuts: [{ position: 2 }] }],
    audio: [{ id: 'one', blob }],
  });
  await withDatabase(fixture, async () => {
    assert.equal(typeof storage.renameProject, 'function');
    const result = await storage.renameProject('one', 'Renamed');
    assert.equal(result.name, 'Renamed');
    assert.equal(result.createdAt, 5);
    assert.ok(result.updatedAt > 5);
    assert.deepEqual(result.customCuts, [{ position: 2 }]);
    assert.equal(fixture.stores.get('projectMeta').get('one').name, 'Renamed');
    assert.equal(fixture.stores.get('projectAudio').get('one').blob, blob);
    assert.equal(fixture.stats.audioReads, 0);
    assert.equal(fixture.stats.audioWrites, 0);
    assert.equal(await storage.renameProject('missing', 'New name'), null);
  });
});
