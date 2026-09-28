import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isIOS,
  isAndroid,
  isMobileDevice,
  shouldPreloadEngine,
  mobileLoadLimitBytes,
  shouldUseNativePreview,
  resolveExportModeForDevice,
} from './device.js';

const desktop = {
  navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', deviceMemory: 8, hardwareConcurrency: 8 },
  matchMedia: () => ({ matches: false }),
};

const iPad = {
  navigator: {
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
    maxTouchPoints: 5,
    deviceMemory: 4,
    hardwareConcurrency: 4,
  },
  matchMedia: (query) => ({ matches: String(query).includes('coarse') }),
};

const android = {
  navigator: {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
    deviceMemory: 6,
    hardwareConcurrency: 8,
    connection: { saveData: false },
  },
  matchMedia: (query) => ({ matches: String(query).includes('coarse') }),
};

describe('device', () => {
  it('rileva iOS, Android e desktop', () => {
    assert.equal(isIOS(iPad), true);
    assert.equal(isIOS(desktop), false);
    assert.equal(isAndroid(android), true);
    assert.equal(isAndroid(desktop), false);
    assert.equal(isMobileDevice(desktop), false);
    assert.equal(isMobileDevice(iPad), true);
    assert.equal(isMobileDevice(android), true);
  });

  it('preload wasm solo su desktop senza risparmi dati', () => {
    assert.equal(shouldPreloadEngine(desktop), true);
    assert.equal(shouldPreloadEngine(iPad), false);
    assert.equal(shouldPreloadEngine(android), false);
    assert.equal(
      shouldPreloadEngine({ navigator: { ...desktop.navigator, connection: { saveData: true } }, matchMedia: desktop.matchMedia }),
      false,
    );
  });

  it('limiti di caricamento differenziati per dispositivo', () => {
    assert.equal(mobileLoadLimitBytes(desktop), Infinity);
    assert.equal(mobileLoadLimitBytes(iPad), 100 * 1024 * 1024);
    assert.equal(mobileLoadLimitBytes(android), 150 * 1024 * 1024);
  });

  it('anteprima nativa solo su mobile per file pesanti', () => {
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 60 }, desktop), false);
    assert.equal(shouldUseNativePreview({ sizeBytes: 200 * 1024 * 1024, durationSeconds: 60 }, desktop), false);
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 60 }, iPad), false);
    assert.equal(shouldUseNativePreview({ sizeBytes: 90 * 1024 * 1024, durationSeconds: 60 }, iPad), true);
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 2000 }, android), true);
  });

  it('su iOS i singoli diventano ZIP unico', () => {
    assert.deepEqual(resolveExportModeForDevice('singles', iPad), {
      mode: 'zip-classic',
      note: 'Su iPhone/iPad uso un unico ZIP (iOS blocca i download multipli).',
    });
    assert.deepEqual(resolveExportModeForDevice('singles', desktop).mode, 'singles');
    assert.deepEqual(resolveExportModeForDevice('zip-classic', iPad).mode, 'zip-classic');
  });
});
