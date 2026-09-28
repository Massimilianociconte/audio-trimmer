import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileBytesWithProgress } from './fileInput.js';

describe('readFileBytesWithProgress', () => {
  it('legge a chunk riportando i bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new Blob([bytes], { type: 'audio/mpeg' });
    Object.defineProperty(file, 'size', { value: 5 });
    const seen = [];
    const out = await readFileBytesWithProgress(file, { onProgress: (loaded, total) => seen.push([loaded, total]) });
    assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5]);
    assert.ok(seen.length > 0);
    assert.deepEqual(seen[seen.length - 1], [5, 5]);
  });

  it('abort interrompe la lettura', async () => {
    const file = new Blob([new Uint8Array(1024)], { type: 'audio/mpeg' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => readFileBytesWithProgress(file, { signal: controller.signal }));
  });

  it('fallback arrayBuffer quando stream manca', async () => {
    const file = { size: 3, arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer };
    const seen = [];
    const out = await readFileBytesWithProgress(file, { onProgress: (loaded, total) => seen.push([loaded, total]) });
    assert.deepEqual(Array.from(out), [7, 8, 9]);
    assert.deepEqual(seen[seen.length - 1], [3, 3]);
  });
});
