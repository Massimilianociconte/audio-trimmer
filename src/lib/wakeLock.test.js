import test from 'node:test';
import assert from 'node:assert/strict';

import { createWakeLockSession } from './wakeLock.js';

function sentinel() {
  const listeners = new Set();
  return {
    releases: 0,
    addEventListener(type, callback) { if (type === 'release') listeners.add(callback); },
    removeEventListener(type, callback) { if (type === 'release') listeners.delete(callback); },
    emitRelease() { for (const callback of listeners) callback(); },
    async release() {
      this.releases += 1;
      this.emitRelease();
    },
  };
}

test('visibility reacquisition shares a pending wake lock request', async () => {
  assert.equal(typeof createWakeLockSession, 'function');
  const lock = sentinel();
  let resolveRequest;
  let requests = 0;
  const changes = [];
  const session = createWakeLockSession({
    navigator: { wakeLock: { request: () => {
      requests += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    } } },
    onChange: (held) => changes.push(held),
  });
  const pending = session.acquire();
  session.acquire();
  session.acquire();
  assert.equal(requests, 1);
  resolveRequest(lock);
  await pending;
  await session.acquire();
  assert.equal(requests, 1);
  assert.deepEqual(changes, [true]);
  session.dispose();
  assert.equal(lock.releases, 1);
  assert.deepEqual(changes, [true]);
});

test('unmount releases a late wake lock without publishing state', async () => {
  assert.equal(typeof createWakeLockSession, 'function');
  const lock = sentinel();
  let resolveRequest;
  const changes = [];
  const session = createWakeLockSession({
    navigator: { wakeLock: { request: () => new Promise((resolve) => { resolveRequest = resolve; }) } },
    onChange: (held) => changes.push(held),
  });
  const pending = session.acquire();
  session.dispose();
  resolveRequest(lock);
  await pending;
  assert.equal(lock.releases, 1);
  assert.deepEqual(changes, []);
  await session.acquire();
  assert.equal(lock.releases, 1);
});

test('released locks can be reacquired and stale release events cannot clear the new lock', async () => {
  assert.equal(typeof createWakeLockSession, 'function');
  const oldLock = sentinel();
  const newLock = sentinel();
  const locks = [oldLock, newLock];
  const changes = [];
  const session = createWakeLockSession({
    navigator: { wakeLock: { request: async () => locks.shift() } },
    onChange: (held) => changes.push(held),
  });
  await session.acquire();
  oldLock.emitRelease();
  await session.acquire();
  oldLock.emitRelease();
  assert.deepEqual(changes, [true, false, true]);
  session.dispose();
  assert.equal(newLock.releases, 1);
});
