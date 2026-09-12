import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_DESTINATION_ORDER,
  EXPORT_DESTINATIONS,
  HEAVY_INPUT_BYTES,
  HEAVY_OUTPUT_BYTES,
  RETAIN_BLOBS_BYTES,
  adviseExportStrategy,
  getExportCapabilities,
} from './streamExport.js';

test('destination registry is complete', () => {
  for (const id of EXPORT_DESTINATION_ORDER) {
    assert.ok(EXPORT_DESTINATIONS[id], `missing destination ${id}`);
  }
});

test('getExportCapabilities detects APIs from env', () => {
  const full = getExportCapabilities({
    showDirectoryPicker: () => {},
    showSaveFilePicker: () => {},
    navigator: { wakeLock: { request: () => {} } },
    WritableStream: function () {},
  });
  assert.equal(full.directoryPicker, true);
  assert.equal(full.filePicker, true);
  assert.equal(full.wakeLock, true);
  assert.equal(full.webStreams, true);

  const empty = getExportCapabilities({});
  assert.equal(empty.directoryPicker, false);
  assert.equal(empty.filePicker, false);
  assert.equal(empty.wakeLock, false);
});

test('heavy jobs prefer folder when available', () => {
  const { mode } = adviseExportStrategy({
    fileSizeBytes: HEAVY_INPUT_BYTES + 1,
    totalEstimateBytes: 10,
    segmentCount: 2,
    capabilities: { directoryPicker: true, filePicker: true },
  });
  assert.equal(mode, 'folder');
});

test('heavy output prefers folder, falls back to zip-stream', () => {
  const folder = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: HEAVY_OUTPUT_BYTES + 1,
    segmentCount: 2,
    capabilities: { directoryPicker: true, filePicker: true },
  });
  assert.equal(folder.mode, 'folder');

  const stream = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: HEAVY_OUTPUT_BYTES + 1,
    segmentCount: 2,
    capabilities: { directoryPicker: false, filePicker: true },
  });
  assert.equal(stream.mode, 'zip-stream');
});

test('many segments trigger incremental writing', () => {
  const { mode, reasons } = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: 10,
    segmentCount: 30,
    capabilities: { directoryPicker: true, filePicker: true },
  });
  assert.equal(mode, 'folder');
  assert.match(reasons.join(' '), /incrementale|disco/i);
});

test('small jobs use in-memory zip when no file picker', () => {
  const { mode } = adviseExportStrategy({
    fileSizeBytes: 1024,
    totalEstimateBytes: RETAIN_BLOBS_BYTES - 1,
    segmentCount: 3,
    capabilities: { directoryPicker: false, filePicker: false },
  });
  assert.equal(mode, 'zip-classic');
});

test('huge jobs without file APIs fall back to singles with warning', () => {
  const { mode, warnings } = adviseExportStrategy({
    fileSizeBytes: 1024,
    totalEstimateBytes: RETAIN_BLOBS_BYTES + 1,
    segmentCount: 3,
    capabilities: { directoryPicker: false, filePicker: false },
  });
  assert.equal(mode, 'singles');
  assert.ok(warnings.length > 0);
});

test('manual preference wins when supported', () => {
  const { mode } = adviseExportStrategy({
    fileSizeBytes: HEAVY_INPUT_BYTES + 1,
    totalEstimateBytes: HEAVY_OUTPUT_BYTES + 1,
    segmentCount: 99,
    capabilities: { directoryPicker: true, filePicker: true },
    preference: 'singles',
  });
  assert.equal(mode, 'singles');
});

test('manual folder without support falls back with warning', () => {
  const { mode, warnings } = adviseExportStrategy({
    fileSizeBytes: 10,
    totalEstimateBytes: 10,
    segmentCount: 2,
    capabilities: { directoryPicker: false, filePicker: true },
    preference: 'folder',
  });
  assert.equal(mode, 'zip-stream');
  assert.ok(warnings.length > 0);
});
