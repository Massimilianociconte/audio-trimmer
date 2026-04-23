import test from 'node:test';
import assert from 'node:assert/strict';

import { formatClock, getExtension, parseTimeInput } from './time.js';

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
