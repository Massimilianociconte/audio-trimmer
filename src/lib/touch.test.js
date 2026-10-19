import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DOUBLE_TAP_MAX_DELAY_MS,
  isCoarsePointerAvailable,
  isDoubleTap,
} from './touch.js';

test('isDoubleTap accepts two quick taps in (almost) the same spot', () => {
  const first = { x: 120, y: 60, time: 1000 };
  assert.equal(isDoubleTap(first, { x: 128, y: 66, time: 1200 }), true);
  assert.equal(isDoubleTap(first, { x: 120, y: 60, time: 1000 + DOUBLE_TAP_MAX_DELAY_MS }), true);
});

test('isDoubleTap rejects slow, distant or out-of-order taps', () => {
  const first = { x: 120, y: 60, time: 1000 };
  assert.equal(isDoubleTap(first, { x: 122, y: 60, time: 1000 + DOUBLE_TAP_MAX_DELAY_MS + 1 }), false);
  assert.equal(isDoubleTap(first, { x: 320, y: 60, time: 1100 }), false);
  assert.equal(isDoubleTap(first, { x: 120, y: 400, time: 1100 }), false);
  assert.equal(isDoubleTap(first, { x: 120, y: 60, time: 900 }), false);
  assert.equal(isDoubleTap(null, { x: 120, y: 60, time: 1100 }), false);
  assert.equal(isDoubleTap(first, null), false);
  assert.equal(isDoubleTap(first, { x: Number.NaN, y: 60, time: 1100 }), false);
});

test('isCoarsePointerAvailable reads any-pointer: coarse and never throws', () => {
  const coarse = { matchMedia: (q) => ({ matches: String(q).includes('any-pointer') }) };
  const fineOnly = { matchMedia: () => ({ matches: false }) };
  assert.equal(isCoarsePointerAvailable(coarse), true);
  assert.equal(isCoarsePointerAvailable(fineOnly), false);
  assert.equal(isCoarsePointerAvailable({}), false);
  assert.equal(isCoarsePointerAvailable({ matchMedia: () => { throw new Error('boom'); } }), false);
});
