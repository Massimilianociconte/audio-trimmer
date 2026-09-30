import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityWatch, withActiveTimeout } from './activityWatch.js';

// Orologio e intervallo finti: ogni tick() avanza il tempo e fa girare il timer.
function fakeClock() {
  let now = 0;
  let callback = null;
  return {
    now: () => now,
    setIntervalFn: (fn) => { callback = fn; return 1; },
    clearIntervalFn: () => { callback = null; },
    advance(ms) { now += ms; callback?.(); },
    get running() { return Boolean(callback); },
  };
}

function watch(clock, limitMs, env = {}) {
  let expired = 0;
  const handle = createActivityWatch({
    limitMs,
    onExpire: () => { expired += 1; },
    env,
    tickMs: 1000,
    now: clock.now,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
  });
  return { handle, expired: () => expired };
}

test('expires after the limit of continuous active time', () => {
  const clock = fakeClock();
  const w = watch(clock, 3000);
  clock.advance(1000);
  clock.advance(1000);
  assert.equal(w.expired(), 0);
  clock.advance(1000);
  assert.equal(w.expired(), 1);
  assert.equal(clock.running, false);
});

test('activity resets the idle time', () => {
  const clock = fakeClock();
  const w = watch(clock, 3000);
  clock.advance(1000);
  clock.advance(1000);
  w.handle.touch();
  clock.advance(1000);
  clock.advance(1000);
  assert.equal(w.expired(), 0);
});

test('a suspended tab (screen locked, app switched) never counts as a stall', () => {
  const clock = fakeClock();
  const w = watch(clock, 120000);
  clock.advance(1000);
  // iPad/telefono: JS congelato 10 minuti, poi un solo tick al ritorno.
  clock.advance(10 * 60 * 1000);
  assert.equal(w.expired(), 0);
  // Il lavoro riprende: il limite riparte dal tempo attivo reale.
  for (let i = 0; i < 100; i += 1) clock.advance(1000);
  assert.equal(w.expired(), 0);
});

test('a hidden page with throttled but running timers does not count either', () => {
  const clock = fakeClock();
  const env = { document: { visibilityState: 'hidden' } };
  const w = watch(clock, 3000, env);
  for (let i = 0; i < 10; i += 1) clock.advance(1000);
  assert.equal(w.expired(), 0);
  env.document.visibilityState = 'visible';
  clock.advance(1000);
  clock.advance(1000);
  clock.advance(1000);
  assert.equal(w.expired(), 1);
});

test('stop prevents any later expiry', () => {
  const clock = fakeClock();
  const w = watch(clock, 2000);
  w.handle.stop();
  clock.advance(1000);
  clock.advance(1000);
  assert.equal(w.expired(), 0);
});

test('withActiveTimeout resolves with the work and clears its timer', async () => {
  assert.equal(await withActiveTimeout(Promise.resolve(42), 50, 'lento'), 42);
});

test('withActiveTimeout rejects a dead operation with an isTimeout error', async () => {
  await assert.rejects(
    withActiveTimeout(new Promise(() => {}), 20, 'Il motore non risponde'),
    (error) => error.isTimeout === true && /non risponde/.test(error.message),
  );
});
