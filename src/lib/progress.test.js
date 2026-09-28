import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01,
  combineLoadProgress,
  combineExportProgress,
  throughputBytesPerSec,
  etaMsRemaining,
  formatEtaClock,
} from './progress.js';
import { readFileBytesWithProgress } from './fileInput.js';

describe('progress math', () => {
  it('clamp01', () => {
    assert.equal(clamp01(2), 1);
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(NaN), 0);
    assert.equal(clamp01(0.4), 0.4);
  });

  it('combineLoadProgress pesa solo frazioni reali', () => {
    assert.equal(combineLoadProgress({ stage: 'reading', stageFrac: 0.5 }), 0.15);
    assert.equal(combineLoadProgress({ stage: 'engine', stageFrac: 1 }), 0.6);
    // fase indeterminata => base fase, mai % inventata
    assert.equal(combineLoadProgress({ stage: 'analysis', stageFrac: null }), 0.6);
    assert.equal(combineLoadProgress({ stage: 'waveform', stageFrac: 1 }), 1);
  });

  it('combineExportProgress da bytes reali', () => {
    assert.equal(combineExportProgress({ bytesDone: 50, segFrac: 0.5, segEstimate: 20, bytesTotal: 100 }), 0.6);
    assert.equal(combineExportProgress({ bytesDone: 0, segFrac: 0, segEstimate: 0, bytesTotal: 0 }), 0);
  });

  it('throughput + ETA', () => {
    assert.equal(throughputBytesPerSec(2000, 2000), 1000);
    assert.equal(throughputBytesPerSec(0, 0), 0);
    assert.equal(etaMsRemaining({ bytesDone: 50, bytesTotal: 100, throughputBps: 10 }), 5000);
    assert.equal(etaMsRemaining({ bytesDone: 100, bytesTotal: 100, throughputBps: 10 }), null);
    assert.equal(etaMsRemaining({ bytesDone: 0, bytesTotal: 100, throughputBps: 0 }), null);
    assert.equal(formatEtaClock(35000), '00:35');
    assert.equal(formatEtaClock(130000), '02:10');
    assert.equal(formatEtaClock(NaN), null);
  });
});

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
});
