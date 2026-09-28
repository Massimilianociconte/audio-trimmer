import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hardResetApp } from './cacheReset.js';
import { writeBlobToFileHandle } from './streamExport.js';

describe('hardResetApp', () => {
  const realCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const realIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  function stubGlobal(name, value) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  function restoreGlobal(name, descriptor) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }

  beforeEach(() => {
    const deleted = [];
    stubGlobal('caches', {
      deleted,
      async keys() {
        return ['workbox-precache-v2-foo', 'ffmpeg-wasm', 'ffmpeg-wasm-v2', 'other-cache'];
      },
      async delete(key) {
        deleted.push(key);
        return true;
      },
    });
    stubGlobal('navigator', {
      serviceWorker: {
        async getRegistrations() {
          return [{ unregister: async () => true }];
        },
      },
    });
    stubGlobal('window', { location: { href: './' } });
    delete globalThis.indexedDB;
  });

  afterEach(() => {
    restoreGlobal('caches', realCaches);
    restoreGlobal('indexedDB', realIndexedDB);
    restoreGlobal('navigator', realNavigator);
    restoreGlobal('window', realWindow);
  });

  it('svuota precache + wasm, deregistra e ricarica con reset', async () => {
    await hardResetApp();
    assert.deepEqual(globalThis.caches.deleted.sort(), [
      'ffmpeg-wasm',
      'ffmpeg-wasm-v2',
      'workbox-precache-v2-foo',
    ]);
    assert.match(globalThis.window.location.href, /^\.\/\?reset=\d+$/);
  });
});

describe('writeBlobToFileHandle', () => {
  it('scrive Uint8Array diretti senza Blob intermedio', async () => {
    const written = [];
    let closed = false;
    const fileHandle = {
      async createWritable() {
        return {
          async write(chunk) {
            written.push(chunk);
          },
          async close() {
            closed = true;
          },
          async abort() {},
        };
      },
    };
    const bytes = new Uint8Array([1, 2, 3]);
    await writeBlobToFileHandle(fileHandle, bytes);
    assert.equal(written.length, 1);
    assert.ok(written[0] instanceof Uint8Array);
    assert.equal(closed, true);
  });

  it('abortisce il writable su errore di scrittura', async () => {
    let aborted = false;
    const fileHandle = {
      async createWritable() {
        return {
          async write() {
            throw new Error('disco pieno');
          },
          async close() {},
          async abort() {
            aborted = true;
          },
        };
      },
    };
    await assert.rejects(() => writeBlobToFileHandle(fileHandle, new Uint8Array([9])));
    assert.equal(aborted, true);
  });
});
