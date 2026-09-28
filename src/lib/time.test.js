import test from 'node:test';
import assert from 'node:assert/strict';

import { clamp, formatBytes, formatClock, getExtension, parseTimeInput, stripExtension } from './time.js';

test('formatClock rolls rounded tenths into the next second', () => {
  assert.equal(formatClock(59.96), '01:00');
  assert.equal(formatClock(3599.96), '01:00:00');
});

test('parseTimeInput accepts strict clock values and rejects ambiguous input', () => {
  assert.equal(parseTimeInput('01:02.5'), 62.5);
  assert.equal(parseTimeInput('1:02:03'), 3723);
  assert.equal(parseTimeInput('1:'), null);
  assert.equal(parseTimeInput('1:75'), null);
  assert.equal(parseTimeInput('1:02:70'), null);
  assert.equal(parseTimeInput('-1'), null);
});

test('getExtension normalizes extension case', () => {
  assert.equal(getExtension('Lezione.MP3'), '.mp3');
});

test('clamp keeps values inside bounds', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-2, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test('formatBytes scales units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('stripExtension removes only the trailing extension', () => {
  assert.equal(stripExtension('lezione.mp3'), 'lezione');
  assert.equal(stripExtension('senza-estensione'), 'senza-estensione');
  assert.equal(stripExtension('Lezione.M4A'), 'Lezione');
});
