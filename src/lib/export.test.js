import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExportArgs,
  buildSegmentFileName,
  canFastCopy,
  estimateExportBytes,
  getExportFormat,
  sanitizeFileName,
} from './export.js';

test('getExportFormat falls back to m4a', () => {
  assert.equal(getExportFormat('unknown').id, 'm4a');
  assert.equal(getExportFormat('mp3').codec, 'libmp3lame');
});

test('sanitizeFileName strips illegal chars and limits length', () => {
  assert.equal(sanitizeFileName('lezione: 1/2?*'), 'lezione 12');
  assert.equal(sanitizeFileName(''), 'audio');
  assert.ok(sanitizeFileName('x'.repeat(500)).length <= 120);
});

test('buildSegmentFileName supports custom labels', () => {
  assert.equal(buildSegmentFileName('lezione', 1, '.m4a'), 'lezione - parte 1.m4a');
  assert.equal(
    buildSegmentFileName('lezione', 2, 'mp3', 'introduzione'),
    'lezione - 02 - introduzione.mp3',
  );
});

test('buildExportArgs uses accurate seek + re-encode by default', () => {
  const args = buildExportArgs({
    segment: { start: 10, duration: 20 },
    inputName: 'in.m4a',
    outputName: 'out.m4a',
    formatId: 'm4a',
    bitrateKbps: 128,
  });
  assert.ok(args.includes('-c:a'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('-b:a'));
  // -ss after input position is not used; we use accurate -ss before -i with -t after
  assert.equal(args[args.indexOf('-ss') + 1], '10.000');
  assert.ok(args.includes('+faststart'));
  assert.ok(args.includes('-y'));
});

test('buildExportArgs supports fast copy without re-encode', () => {
  const args = buildExportArgs({
    segment: { start: 0, duration: 5 },
    inputName: 'in.m4a',
    outputName: 'out.m4a',
    formatId: 'm4a',
    fastCopy: true,
  });
  assert.ok(args.includes('copy'));
  assert.ok(!args.includes('aac'));
});

test('buildExportArgs adds fade filter when requested', () => {
  const args = buildExportArgs({
    segment: { start: 0, duration: 30 },
    inputName: 'in.mp3',
    outputName: 'out.mp3',
    formatId: 'mp3',
    bitrateKbps: 192,
    fadeSeconds: 1,
  });
  const afIndex = args.indexOf('-af');
  assert.ok(afIndex > -1);
  assert.match(args[afIndex + 1], /afade/);
});

test('buildExportArgs skips fade when segment too short', () => {
  const args = buildExportArgs({
    segment: { start: 0, duration: 1 },
    inputName: 'in.mp3',
    outputName: 'out.mp3',
    formatId: 'mp3',
    fadeSeconds: 1,
  });
  assert.ok(!args.includes('-af'));
});

test('canFastCopy only for matching containers', () => {
  assert.equal(canFastCopy({ formatId: 'm4a', sourceExtension: '.m4a' }), true);
  assert.equal(canFastCopy({ formatId: 'm4a', sourceExtension: '.mp3' }), false);
  assert.equal(canFastCopy({ formatId: 'wav', sourceExtension: '.wav' }), false);
});

test('estimateExportBytes scales with bitrate and duration', () => {
  const small = estimateExportBytes({ durationSeconds: 60, bitrateKbps: 64, formatId: 'm4a' });
  const big = estimateExportBytes({ durationSeconds: 60, bitrateKbps: 256, formatId: 'm4a' });
  assert.ok(big > small);
  const wav = estimateExportBytes({ durationSeconds: 60, bitrateKbps: 0, formatId: 'wav' });
  assert.ok(wav > big);
});

test('buildExportArgs encodes ogg with libvorbis and no movflags', () => {
  const args = buildExportArgs({
    segment: { start: 0, duration: 10 },
    inputName: 'in.wav',
    outputName: 'out.ogg',
    formatId: 'ogg',
    bitrateKbps: 128,
  });
  assert.ok(args.includes('libvorbis'));
  assert.ok(args.includes('-b:a'));
  assert.ok(!args.includes('+faststart'));
});

test('buildExportArgs encodes wav as pcm without bitrate flag', () => {
  const args = buildExportArgs({
    segment: { start: 0, duration: 10 },
    inputName: 'in.m4a',
    outputName: 'out.wav',
    formatId: 'wav',
    bitrateKbps: 128,
  });
  assert.ok(args.includes('pcm_s16le'));
  assert.ok(!args.includes('-b:a'));
  assert.ok(!args.includes('+faststart'));
});

test('buildExportArgs snaps mp3 bitrate to the nearest supported value', () => {
  const at100 = buildExportArgs({
    segment: { start: 0, duration: 10 },
    inputName: 'i', outputName: 'o', formatId: 'mp3', bitrateKbps: 100,
  });
  assert.equal(at100[at100.indexOf('-b:a') + 1], '96k');
  const at200 = buildExportArgs({
    segment: { start: 0, duration: 10 },
    inputName: 'i', outputName: 'o', formatId: 'mp3', bitrateKbps: 200,
  });
  assert.equal(at200[at200.indexOf('-b:a') + 1], '192k');
  const at300 = buildExportArgs({
    segment: { start: 0, duration: 10 },
    inputName: 'i', outputName: 'o', formatId: 'mp3', bitrateKbps: 300,
  });
  assert.equal(at300[at300.indexOf('-b:a') + 1], '320k');
});

test('buildExportArgs ignores fastCopy for wav and ogg', () => {
  const wavArgs = buildExportArgs({
    segment: { start: 0, duration: 10 },
    inputName: 'in.wav', outputName: 'out.wav', formatId: 'wav', fastCopy: true,
  });
  assert.ok(wavArgs.includes('pcm_s16le'));
  assert.ok(!wavArgs.includes('copy'));
  const oggArgs = buildExportArgs({
    segment: { start: 0, duration: 10 },
    inputName: 'in.ogg', outputName: 'out.ogg', formatId: 'ogg', fastCopy: true,
  });
  assert.ok(oggArgs.includes('libvorbis'));
  assert.ok(!oggArgs.includes('copy'));
});

test('buildExportArgs skips fade when duration equals twice the fade', () => {
  const args = buildExportArgs({
    segment: { start: 0, duration: 2 },
    inputName: 'in.mp3', outputName: 'out.mp3', formatId: 'mp3', fadeSeconds: 1,
  });
  assert.ok(!args.includes('-af'));
});

test('buildExportArgs caps fade at 5 seconds', () => {
  const args = buildExportArgs({
    segment: { start: 0, duration: 30 },
    inputName: 'in.mp3', outputName: 'out.mp3', formatId: 'mp3', fadeSeconds: 10,
  });
  const filter = args[args.indexOf('-af') + 1];
  assert.equal(filter, 'afade=t=in:st=0:d=5,afade=t=out:st=25.000:d=5');
});

test('sanitizeFileName keeps unicode and documents edge inputs', () => {
  assert.equal(sanitizeFileName('CON'), 'CON');
  assert.equal(sanitizeFileName('../evil'), '..evil');
  assert.equal(sanitizeFileName('🎧 lezione 1'), '🎧 lezione 1');
  assert.equal(sanitizeFileName('  a   b  '), 'a b');
  assert.equal(sanitizeFileName(null), 'audio');
  assert.equal(sanitizeFileName('   '), 'audio');
});

test('sanitizeFileName strips control characters only via trimming, keeps inner ones', () => {
  assert.equal(sanitizeFileName('\u0000test\u001f'), '\u0000test\u001f');
});

test('canFastCopy matrix across formats and source extensions', () => {
  for (const src of ['.m4a', '.aac', '.mp4', '.MP4']) {
    assert.equal(canFastCopy({ formatId: 'm4a', sourceExtension: src }), true, src);
  }
  for (const src of ['.mp3', '.wav', '.ogg', '', undefined]) {
    assert.equal(canFastCopy({ formatId: 'm4a', sourceExtension: src }), false, String(src));
  }
  assert.equal(canFastCopy({ formatId: 'mp3', sourceExtension: '.mp3' }), true);
  assert.equal(canFastCopy({ formatId: 'mp3', sourceExtension: '.MP3' }), true);
  assert.equal(canFastCopy({ formatId: 'mp3', sourceExtension: '.m4a' }), false);
  assert.equal(canFastCopy({ formatId: 'wav', sourceExtension: '.wav' }), false);
  assert.equal(canFastCopy({ formatId: 'ogg', sourceExtension: '.ogg' }), false);
});

test('getExportFormat falls back to m4a for missing ids', () => {
  assert.equal(getExportFormat(undefined).id, 'm4a');
  assert.equal(getExportFormat(null).id, 'm4a');
});

test('estimateExportBytes uses exact wav size and bitrate fallback', () => {
  assert.equal(
    estimateExportBytes({ durationSeconds: 60, bitrateKbps: 0, formatId: 'wav' }),
    60 * 44100 * 2 * 2,
  );
  assert.equal(
    estimateExportBytes({ durationSeconds: 60, bitrateKbps: NaN, formatId: 'mp3' }),
    Math.round((128 * 1000 * 60) / 8),
  );
});

test('buildSegmentFileName normalizes extension and strips label chars', () => {
  assert.equal(buildSegmentFileName('', 1, '.m4a'), 'audio - parte 1.m4a');
  assert.equal(buildSegmentFileName('lez', 3, 'mp3', 'a/b:c'), 'lez - 03 - abc.mp3');
});
