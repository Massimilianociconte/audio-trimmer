import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAST_LOAD_STAGES,
  clamp01,
  combineLoadProgress,
  combineExportProgress,
  combineSecondsProgress,
  etaMsFromSpeed,
  throughputBytesPerSec,
  etaMsRemaining,
  formatDurationShort,
  formatEtaClock,
  formatSpeedFactor,
  isFfmpegProgressLine,
  loadStageIndex,
  loadStageLabel,
  parseFfmpegProgressSeconds,
  speedFactor,
} from './progress.js';

describe('progress math', () => {
  it('clamp01', () => {
    assert.equal(clamp01(2), 1);
    assert.equal(clamp01(-1), 0);
    assert.equal(clamp01(NaN), 0);
    assert.equal(clamp01(0.4), 0.4);
  });

  it('combineLoadProgress pesa solo frazioni reali', () => {
    assert.equal(combineLoadProgress({ stage: 'metadata', stageFrac: 0 }), 0);
    assert.equal(combineLoadProgress({ stage: 'engine', stageFrac: 1 }), 0.55);
    // fase indeterminata => base fase, mai % inventata
    assert.equal(combineLoadProgress({ stage: 'analysis', stageFrac: null }), 0.55);
    assert.equal(combineLoadProgress({ stage: 'waveform', stageFrac: 1 }), 1);
  });

  it('combineLoadProgress normalizza sul percorso veloce senza motore', () => {
    assert.equal(combineLoadProgress({ stage: 'waveform', stageFrac: 0, stages: FAST_LOAD_STAGES }), 0.25);
    assert.equal(combineLoadProgress({ stage: 'waveform', stageFrac: 1, stages: FAST_LOAD_STAGES }), 1);
  });

  it('combineExportProgress da bytes reali', () => {
    assert.equal(combineExportProgress({ bytesDone: 50, segFrac: 0.5, segEstimate: 20, bytesTotal: 100 }), 0.6);
    assert.equal(combineExportProgress({ bytesDone: 0, segFrac: 0, segEstimate: 0, bytesTotal: 0 }), 0);
  });

  it('combineSecondsProgress da secondi audio elaborati', () => {
    assert.equal(combineSecondsProgress({ doneSeconds: 60, segSeconds: 40, segFrac: 0.5, totalSeconds: 100 }), 0.8);
    assert.equal(combineSecondsProgress({ doneSeconds: 10, totalSeconds: 0 }), 0);
    assert.equal(combineSecondsProgress({ doneSeconds: 100, segSeconds: 50, segFrac: 1, totalSeconds: 100 }), 1);
  });

  it('speedFactor + etaMsFromSpeed', () => {
    assert.equal(speedFactor(120, 4000), 30);
    assert.equal(speedFactor(120, 100), 0);
    assert.equal(speedFactor(0, 4000), 0);
    assert.equal(etaMsFromSpeed({ remainingSeconds: 300, speed: 30 }), 10000);
    assert.equal(etaMsFromSpeed({ remainingSeconds: 300, speed: 0 }), null);
    assert.equal(etaMsFromSpeed({ remainingSeconds: 0, speed: 10 }), null);
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

  it('formatDurationShort + formatSpeedFactor', () => {
    assert.equal(formatDurationShort(0.4), '1 s');
    assert.equal(formatDurationShort(42), '42 s');
    assert.equal(formatDurationShort(80), '1 min 20 s');
    assert.equal(formatDurationShort(120), '2 min');
    assert.equal(formatDurationShort(725), '12 min');
    assert.equal(formatDurationShort(NaN), null);
    assert.equal(formatSpeedFactor(3.46), '3,5×');
    assert.equal(formatSpeedFactor(123.4), '123×');
    assert.equal(formatSpeedFactor(0), null);
  });

  it('parseFfmpegProgressSeconds legge le righe di -progress', () => {
    assert.equal(parseFfmpegProgressSeconds('out_time_us=57213968'), 57.213968);
    assert.equal(parseFfmpegProgressSeconds('out_time_ms=1500000'), 1.5);
    assert.equal(parseFfmpegProgressSeconds('out_time=00:01:02.500000'), 62.5);
    assert.equal(parseFfmpegProgressSeconds('out_time=-577014:32:22.775808'), null);
    assert.equal(parseFfmpegProgressSeconds('out_time_us=N/A'), null);
    assert.equal(parseFfmpegProgressSeconds('progress=continue'), null);
    assert.equal(parseFfmpegProgressSeconds('[silencedetect] silence_start: 12'), null);
  });

  it('isFfmpegProgressLine riconosce solo le chiavi di -progress', () => {
    assert.equal(isFfmpegProgressLine('out_time_us=100'), true);
    assert.equal(isFfmpegProgressLine('progress=end'), true);
    assert.equal(isFfmpegProgressLine('bitrate= 129.7kbits/s'), false);
    assert.equal(isFfmpegProgressLine('bitrate=129.7kbits/s'), true);
    assert.equal(isFfmpegProgressLine('[silencedetect @ 0x1] silence_end: 3 | silence_duration: 2'), false);
  });

  it('loadStageIndex + loadStageLabel', () => {
    assert.equal(loadStageIndex('metadata'), 0);
    assert.equal(loadStageIndex('waveform'), 3);
    assert.equal(loadStageIndex('waveform', FAST_LOAD_STAGES), 1);
    assert.equal(loadStageIndex('sconosciuto'), 0);
    assert.equal(loadStageLabel('engine'), 'Motore di taglio');
    assert.equal(loadStageLabel('waveform'), 'Forma d’onda');
  });
});
