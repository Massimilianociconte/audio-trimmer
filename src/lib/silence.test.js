import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSilenceDetectFilter,
  parseSilenceLog,
  silencesToCutPoints,
} from './silence.js';

const REAL_LOG = [
  '[silencedetect @ 0x7f8b1c004400] silence_start: 1.5',
  '[silencedetect @ 0x7f8b1c004400] silence_end: 3.2 | silence_duration: 1.7',
  'frame=  100 fps=0.0 size=N/A time=00:00:05.00 bitrate=N/A speed=10x',
  '[silencedetect @ 0x7f8b1c004400] silence_start: 10.0',
  '[silencedetect @ 0x7f8b1c004400] silence_end: 12.5 | silence_duration: 2.5',
  '[silencedetect @ 0x7f8b1c004400] silence_start: 20',
  '[silencedetect @ 0x7f8b1c004400] silence_end: 21.5 | silence_duration: 1.5',
].join('\n');

test('parseSilenceLog parses a real multi-pair ffmpeg log', () => {
  assert.deepEqual(parseSilenceLog(REAL_LOG), [
    { start: 1.5, end: 3.2, duration: 1.7 },
    { start: 10, end: 12.5, duration: 2.5 },
    { start: 20, end: 21.5, duration: 1.5 },
  ]);
});

test('parseSilenceLog ignores non-silence lines', () => {
  assert.deepEqual(parseSilenceLog('frame= 10 fps=30 size=1kB time=1.00\nnothing here'), []);
});

test('parseSilenceLog pairs positionally when starts exceed ends', () => {
  const log = 'silence_start: 1\nsilence_end: 2 | silence_duration: 1\nsilence_start: 50';
  assert.deepEqual(parseSilenceLog(log), [{ start: 1, end: 2, duration: 1 }]);
});

test('parseSilenceLog drops pairs where end <= start', () => {
  assert.deepEqual(parseSilenceLog('silence_start: 5.0\nsilence_end: 3.0 | silence_duration: 1.0'), []);
  assert.deepEqual(parseSilenceLog('silence_start: 5.0\nsilence_end: 5.0 | silence_duration: 0'), []);
});

test('parseSilenceLog returns [] for empty or missing input', () => {
  assert.deepEqual(parseSilenceLog(''), []);
  assert.deepEqual(parseSilenceLog(null), []);
  assert.deepEqual(parseSilenceLog(undefined), []);
});

test('parseSilenceLog keeps the logged duration value as-is', () => {
  const [only] = parseSilenceLog('silence_start: 1\nsilence_end: 3.2 | silence_duration: 1.7');
  assert.equal(only.duration, 1.7);
});

test('buildSilenceDetectFilter uses defaults', () => {
  assert.equal(buildSilenceDetectFilter({}), 'silencedetect=noise=-30dB:d=2');
});

test('buildSilenceDetectFilter applies custom values', () => {
  assert.equal(
    buildSilenceDetectFilter({ thresholdDb: -40, minSilenceSeconds: 0.5 }),
    'silencedetect=noise=-40dB:d=0.5',
  );
});

test('buildSilenceDetectFilter falls back on NaN inputs', () => {
  assert.equal(
    buildSilenceDetectFilter({ thresholdDb: NaN, minSilenceSeconds: NaN }),
    'silencedetect=noise=-30dB:d=2',
  );
});

test('buildSilenceDetectFilter falls back on non-positive duration', () => {
  assert.equal(buildSilenceDetectFilter({ minSilenceSeconds: -3 }), 'silencedetect=noise=-30dB:d=2');
  assert.equal(buildSilenceDetectFilter({ minSilenceSeconds: 0 }), 'silencedetect=noise=-30dB:d=2');
});

test('silencesToCutPoints returns midpoints of long-enough segments', () => {
  assert.deepEqual(
    silencesToCutPoints({
      silences: [
        { start: 4, end: 6 },
        { start: 14, end: 16 },
      ],
      duration: 20,
    }),
    [5, 15],
  );
});

test('silencesToCutPoints with minSegmentLength=0 returns all candidates', () => {
  assert.deepEqual(
    silencesToCutPoints({
      silences: [
        { start: 0.1, end: 0.3 },
        { start: 19.7, end: 19.9 },
      ],
      duration: 20,
      minSegmentLength: 0,
    }),
    [0.25, 19.75],
  );
});

test('silencesToCutPoints clamps cuts near the edges', () => {
  assert.deepEqual(
    silencesToCutPoints({ silences: [{ start: 0, end: 0.1 }], duration: 10, minSegmentLength: 0 }),
    [0.25],
  );
  assert.deepEqual(
    silencesToCutPoints({ silences: [{ start: 9.9, end: 10 }], duration: 10, minSegmentLength: 0 }),
    [9.75],
  );
});

test('silencesToCutPoints deduplicates identical midpoints', () => {
  assert.deepEqual(
    silencesToCutPoints({
      silences: [
        { start: 4, end: 6 },
        { start: 4, end: 6 },
      ],
      duration: 20,
    }),
    [5],
  );
});

test('silencesToCutPoints drops a trailing cut closer than minSegmentLength to the end', () => {
  assert.deepEqual(
    silencesToCutPoints({
      silences: [
        { start: 4, end: 6 },
        { start: 17, end: 19 },
      ],
      duration: 20,
    }),
    [5],
  );
});

test('silencesToCutPoints skips cuts too close to the previous one', () => {
  assert.deepEqual(
    silencesToCutPoints({
      silences: [
        { start: 4, end: 6 },
        { start: 6.5, end: 8.5 },
      ],
      duration: 30,
    }),
    [5],
  );
});

test('silencesToCutPoints returns [] for missing silences or invalid duration', () => {
  assert.deepEqual(silencesToCutPoints({ silences: [], duration: 20 }), []);
  assert.deepEqual(silencesToCutPoints({ silences: [{ start: 1, end: 2 }], duration: 0 }), []);
  assert.deepEqual(silencesToCutPoints({ silences: [{ start: 1, end: 2 }], duration: -5 }), []);
  assert.deepEqual(silencesToCutPoints({ silences: 'nope', duration: 20 }), []);
});
