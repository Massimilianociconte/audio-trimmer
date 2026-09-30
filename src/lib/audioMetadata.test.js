import test from 'node:test';
import assert from 'node:assert/strict';
import { readAudioDurationFromBrowser } from './audioMetadata.js';

function browserFixture() {
  const created = [];
  const timers = new Set();
  const env = {
    document: { createElement() {
      const audio = {
        duration: 120,
        canPlayType: () => 'probably',
        pauseCalls: 0, loadCalls: 0,
        pause() { this.pauseCalls += 1; },
        removeAttribute(name) { delete this[name]; },
        load() { this.loadCalls += 1; },
      };
      created.push(audio);
      return audio;
    } },
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
  };
  return { env, created, timers };
}

test('cancelling metadata immediately releases the media source and timer', async () => {
  const { env, created, timers } = browserFixture();
  const controller = new AbortController();
  const reading = readAudioDurationFromBrowser('blob:large', '', { signal: controller.signal, env });
  const rejection = assert.rejects(reading, { name: 'AbortError' });
  controller.abort();
  assert.equal(created.length, 1);
  assert.equal(created[0].src, undefined);
  assert.equal(created[0].pauseCalls, 1);
  assert.equal(created[0].loadCalls, 1);
  assert.equal(created[0].onloadedmetadata, null);
  assert.equal(timers.size, 0);
  await rejection;
});

test('metadata success releases source and ignores later cancellation', async () => {
  const { env, created, timers } = browserFixture();
  const controller = new AbortController();
  const reading = readAudioDurationFromBrowser('blob:large', '', { signal: controller.signal, env });
  assert.equal(created.length, 1);
  created[0].onloadedmetadata();
  assert.equal(await reading, 120);
  controller.abort();
  assert.equal(created[0].pauseCalls, 1);
  assert.equal(timers.size, 0);
});

test('an already cancelled metadata request never opens media', async () => {
  const { env, created } = browserFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readAudioDurationFromBrowser('blob:large', '', { signal: controller.signal, env }), { name: 'AbortError' });
  assert.equal(created.length, 0);
});

test('metadata timeout releases the audio element', async () => {
  const { env, created, timers } = browserFixture();
  const reading = readAudioDurationFromBrowser('blob:large', '', { env });
  const rejection = assert.rejects(reading, /Timeout metadata browser/);
  assert.equal(timers.size, 1);
  [...timers][0]();
  await rejection;
  assert.equal(created[0].src, undefined);
  assert.equal(timers.size, 0);
});
