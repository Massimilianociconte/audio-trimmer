import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateWaveformBytes,
  isIOS,
  isAndroid,
  isMobileDevice,
  shouldPreloadEngine,
  mobileLoadLimitBytes,
  shouldUseNativePreview,
  shouldWarmEngineInBackground,
  resolveExportModeForDevice,
  waveformSampleRate,
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

  it('la selezione File non impone un limite arbitrario alla dimensione', () => {
    assert.equal(mobileLoadLimitBytes(desktop), Infinity);
    assert.equal(mobileLoadLimitBytes(iPad), Infinity);
    // Le allocazioni effettive hanno guardie separate dalla selezione.
    assert.equal(mobileLoadLimitBytes(android), Infinity);
  });

  it('stima PCM della waveform a 8kHz stereo', () => {
    // 30min stereo = 1800×8000×2×4 = 115_200_000 byte esatti
    assert.equal(estimateWaveformBytes(1800), 115200000);
    assert.equal(estimateWaveformBytes(0), 0);
    assert.equal(estimateWaveformBytes(NaN), 0);
  });

  it('anteprima nativa su PCM stimato, non su byte compressi', () => {
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 60 }, desktop), false);
    // 14MB compressi ma 30min di PCM ≈ 115MB: nativa anche su desktop per lo staging del decoder
    assert.equal(shouldUseNativePreview({ sizeBytes: 14 * 1024 * 1024, durationSeconds: 1800 }, iPad), true);
    assert.equal(shouldUseNativePreview({ sizeBytes: 14 * 1024 * 1024, durationSeconds: 1800 }, desktop), true);
    // 20min stereo ≈ 77MB PCM > 60MB: nativa anche sotto gli 80MB compressi
    assert.equal(shouldUseNativePreview({ sizeBytes: 60 * 1024 * 1024, durationSeconds: 1200 }, android), true);
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 60 }, iPad), false);
    assert.equal(shouldUseNativePreview({ sizeBytes: 90 * 1024 * 1024, durationSeconds: 60 }, iPad), true);
    // Guardia assoluta desktop: 3h di PCM o 300MB di file
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 10800 }, desktop), true);
    assert.equal(shouldUseNativePreview({ sizeBytes: 300 * 1024 * 1024, durationSeconds: 60 }, desktop), true);
  });

  it('su iOS i singoli diventano ZIP unico', () => {
    assert.deepEqual(resolveExportModeForDevice('singles', iPad), {
      mode: 'zip-classic',
      note: 'Su iPhone/iPad uso un unico ZIP (iOS blocca i download multipli).',
    });
    assert.deepEqual(resolveExportModeForDevice('singles', desktop).mode, 'singles');
    assert.deepEqual(resolveExportModeForDevice('zip-classic', iPad).mode, 'zip-classic');
  });

  it('warm-up motore solo su desktop adeguati, senza risparmio dati / 2G', () => {
    assert.equal(shouldWarmEngineInBackground(desktop), true);
    assert.equal(shouldWarmEngineInBackground(android), false);
    assert.equal(shouldWarmEngineInBackground(iPad), false);
    assert.equal(shouldWarmEngineInBackground({ ...desktop, navigator: { ...desktop.navigator, deviceMemory: 2 } }), false);
    assert.equal(shouldWarmEngineInBackground({ ...desktop, navigator: { ...desktop.navigator, hardwareConcurrency: 2 } }), false);
    assert.equal(shouldWarmEngineInBackground({ navigator: { connection: { saveData: true } } }), false);
    assert.equal(shouldWarmEngineInBackground({ navigator: { connection: { effectiveType: '2g' } } }), false);
    assert.equal(shouldWarmEngineInBackground({}), true);
  });

  it('PC deboli usano l’anteprima leggera prima dei PC potenti', () => {
    const lowEnd = {
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', deviceMemory: 4, hardwareConcurrency: 4 },
      matchMedia: () => ({ matches: false }),
    };
    // 1h stereo: lo staging del decoder eccede il budget anche sul PC potente.
    assert.equal(shouldUseNativePreview({ sizeBytes: 60 * 1024 * 1024, durationSeconds: 3600 }, desktop), true);
    assert.equal(shouldUseNativePreview({ sizeBytes: 60 * 1024 * 1024, durationSeconds: 3600 }, lowEnd), true);
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 60 }, lowEnd), false);
  });

  it('decodifica la forma d’onda a 3 kHz sui dispositivi deboli che lo supportano', () => {
    class OfflineOk {
      constructor(channels, length, rate) {
        if (rate < 3000) {
          throw new Error('NotSupportedError');
        }
      }
    }
    class OfflineMin8k {
      constructor(channels, length, rate) {
        if (rate < 8000) {
          throw new Error('NotSupportedError');
        }
      }
    }
    assert.equal(waveformSampleRate({ ...android, OfflineAudioContext: OfflineOk }), 3000);
    assert.equal(waveformSampleRate({ ...android, OfflineAudioContext: OfflineMin8k }), 8000);
    assert.equal(waveformSampleRate({ ...desktop, OfflineAudioContext: OfflineOk }), 8000);
    assert.equal(waveformSampleRate(android), 8000);
    assert.equal(estimateWaveformBytes(3600, 3000), 3600 * 3000 * 2 * 4);
    // Lo staging nativo protegge gli audio lunghi anche a 3 kHz
    const phone = { ...android, OfflineAudioContext: OfflineOk };
    assert.equal(shouldUseNativePreview({ sizeBytes: 50 * 1024 * 1024, durationSeconds: 3600, sampleRate: 8000 }, phone), true);
    assert.equal(shouldUseNativePreview({ sizeBytes: 10 * 1024 * 1024, durationSeconds: 1800 }, phone), true);
  });
});

it('waveform guards include compressed input copies in peak memory', () => {
 assert.equal(shouldUseNativePreview({sizeBytes:250*1024*1024,durationSeconds:1486},desktop),true);
 assert.equal(shouldUseNativePreview({sizeBytes:100*1024*1024,durationSeconds:594},iPad),true);
});

it('native decoder staging also counts toward the preview budget', () => {
 // WAVs measured with Chromium RSS: the native decoder costs more than the
 // final 3/8 kHz Float32 buffer retained by WaveSurfer.
 assert.equal(shouldUseNativePreview({sizeBytes:100*1024*1024,durationSeconds:594},desktop),true);
 assert.equal(shouldUseNativePreview({sizeBytes:25*1024*1024,durationSeconds:149},iPad),true);
});
