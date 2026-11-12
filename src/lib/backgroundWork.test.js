import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHROME_SILENCE_THRESHOLD_DBFS,
  KEEP_ALIVE_TONE,
  buildKeepAliveWav,
  canWorkInBackground,
  createBackgroundSession,
} from './backgroundWork.js';

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function pcmSamples(wav) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const samples = [];
  for (let offset = 44; offset < wav.byteLength; offset += 2) samples.push(view.getInt16(offset, true) / 32768);
  return samples;
}

test('buildKeepAliveWav: WAV PCM 16 bit mono valido, della durata prevista', () => {
  const wav = buildKeepAliveWav();
  const text = (from, to) => String.fromCharCode(...wav.slice(from, to));
  const view = new DataView(wav.buffer);
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 12), 'WAVE');
  assert.equal(text(12, 16), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), KEEP_ALIVE_TONE.sampleRate);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36, 40), 'data');
  const frames = KEEP_ALIVE_TONE.sampleRate * KEEP_ALIVE_TONE.seconds;
  assert.equal(view.getUint32(40, true), frames * 2);
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  // Chrome mostra la notifica (e tiene vivo il processo) solo per media ≥ 5 s.
  assert.ok(KEEP_ALIVE_TONE.seconds >= 5);
});

test('buildKeepAliveWav: per Chrome è udibile (sopra −72,25 dBFS), per le orecchie quasi nulla', () => {
  const samples = pcmSamples(buildKeepAliveWav());
  const meanSquare = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
  const powerDbfs = 10 * Math.log10(meanSquare);
  const peakDbfs = 20 * Math.log10(Math.max(...samples.map(Math.abs)));
  // Margine ampio sulla soglia di Chromium (services/audio/output_stream.cc).
  assert.ok(powerDbfs > CHROME_SILENCE_THRESHOLD_DBFS + 15, `potenza ${powerDbfs.toFixed(1)} dBFS`);
  assert.ok(peakDbfs <= -49.5, `picco ${peakDbfs.toFixed(1)} dBFS`);
  // 30 Hz: sotto la soglia dell'udito a questo livello e fuori dalla risposta degli altoparlanti.
  assert.ok(KEEP_ALIVE_TONE.frequency <= 40);
});

test('buildKeepAliveWav: il loop non ha scatti (numero intero di periodi)', () => {
  const { sampleRate, seconds, frequency } = KEEP_ALIVE_TONE;
  assert.equal((frequency * seconds) % 1, 0);
  const samples = pcmSamples(buildKeepAliveWav());
  assert.equal(samples[0], 0);
  const step = Math.abs(samples[1] - samples[0]);
  const seam = Math.abs(samples[0] - samples.at(-1));
  assert.ok(seam <= step * 1.01, 'il salto tra fine e inizio è come quello tra due campioni');
  assert.equal(samples.length, sampleRate * seconds);
});

test('canWorkInBackground: solo Android con audio HTML; iPad e desktop restano come prima', () => {
  const base = { Audio: class {}, Blob: class {}, URL: { createObjectURL: () => 'blob:x' } };
  assert.equal(canWorkInBackground({ ...base, navigator: { userAgent: ANDROID_UA } }), true);
  assert.equal(canWorkInBackground({ ...base, navigator: { userAgent: IPAD_UA, maxTouchPoints: 5 } }), false);
  assert.equal(canWorkInBackground({ ...base, navigator: { userAgent: DESKTOP_UA } }), false);
  assert.equal(canWorkInBackground({ navigator: { userAgent: ANDROID_UA } }), false);
  assert.equal(canWorkInBackground(undefined), false);
});

function fakeEnv({ playRejects = false } = {}) {
  const created = [];
  const revoked = [];
  const handlers = {};
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) {
      if (handler) handlers[action] = handler;
      else delete handlers[action];
    },
  };
  class FakeAudio {
    constructor() {
      this.listeners = {};
      this.paused = true;
      this.loads = 0;
      this.src = '';
      created.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== fn);
    }
    emit(type) {
      for (const fn of this.listeners[type] || []) fn();
    }
    play() {
      if (playRejects) return Promise.reject(new Error('NotAllowedError'));
      this.paused = false;
      queueMicrotask(() => this.emit('playing'));
      return Promise.resolve();
    }
    pause() {
      if (this.paused) return;
      this.paused = true;
      queueMicrotask(() => this.emit('pause'));
    }
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    }
    load() {
      this.loads += 1;
    }
  }
  class FakeMetadata {
    constructor(init) {
      Object.assign(this, init);
    }
  }
  const env = {
    navigator: { userAgent: ANDROID_UA, mediaSession },
    Audio: FakeAudio,
    MediaMetadata: FakeMetadata,
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options?.type;
      }
    },
    URL: {
      createObjectURL: () => `blob:tone-${created.length}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
  };
  return { env, created, revoked, handlers, mediaSession };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('sessione: start fa suonare il tono in loop e mostra la notifica con l’avanzamento', async () => {
  const fake = fakeEnv();
  const states = [];
  const session = createBackgroundSession({ env: fake.env, onChange: (state) => states.push(state) });
  session.start({ title: 'Taglio in corso · 10%', artist: 'Parte 1 di 4' });
  await flush();
  const [audio] = fake.created;
  assert.equal(fake.created.length, 1);
  assert.equal(audio.loop, true);
  assert.match(audio.src, /^blob:/);
  assert.equal(audio.paused, false);
  assert.equal(session.state(), 'running');
  assert.deepEqual(states, ['starting', 'running']);
  assert.equal(fake.mediaSession.metadata.title, 'Taglio in corso · 10%');
  assert.equal(fake.mediaSession.metadata.artist, 'Parte 1 di 4');
  assert.equal(fake.mediaSession.playbackState, 'playing');
  assert.equal(typeof fake.handlers.pause, 'function');
});

test('sessione: gli aggiornamenti della notifica sono diradati, tranne quelli forzati', async () => {
  let clock = 0;
  const fake = fakeEnv();
  const session = createBackgroundSession({ env: fake.env, now: () => clock });
  session.start({ title: 'A', artist: 'x' });
  await flush();
  clock = 1000;
  session.update({ title: 'B', artist: 'x' });
  assert.equal(fake.mediaSession.metadata.title, 'A');
  session.update({ title: 'C', artist: 'x' }, { force: true });
  assert.equal(fake.mediaSession.metadata.title, 'C');
  clock = 6000;
  session.update({ title: 'D', artist: 'x' });
  assert.equal(fake.mediaSession.metadata.title, 'D');
  clock = 20000;
  session.update({ title: 'D', artist: 'x' });
  assert.equal(fake.mediaSession.metadata.title, 'D');
});

test('sessione: una pausa del sistema (altra app usa l’audio) diventa «interrupted» e resume riparte', async () => {
  const fake = fakeEnv();
  const session = createBackgroundSession({ env: fake.env });
  session.start({ title: 'A', artist: 'x' });
  await flush();
  fake.created[0].pause();
  await flush();
  assert.equal(session.state(), 'interrupted');
  session.resume();
  await flush();
  assert.equal(session.state(), 'running');
  assert.equal(fake.created.length, 1, 'stesso elemento audio');
});

test('sessione: «pausa» dalla notifica ferma il tono; «play» lo riprende finché c’è lavoro', async () => {
  const fake = fakeEnv();
  const session = createBackgroundSession({ env: fake.env });
  session.start({ title: 'A', artist: 'x' });
  await flush();
  fake.handlers.pause();
  await flush();
  assert.equal(session.state(), 'interrupted');
  assert.equal(fake.created[0].paused, true);
  assert.equal(fake.mediaSession.playbackState, 'paused');
  fake.handlers.play();
  await flush();
  assert.equal(session.state(), 'running');
});

test('sessione: se il browser rifiuta di suonare lo stato è «blocked», senza eccezioni', async () => {
  const fake = fakeEnv({ playRejects: true });
  const session = createBackgroundSession({ env: fake.env });
  session.start({ title: 'A', artist: 'x' });
  await flush();
  assert.equal(session.state(), 'blocked');
});

test('sessione: finish ferma il tono e lascia nella notifica l’esito; clear toglie tutto', async () => {
  const fake = fakeEnv();
  const session = createBackgroundSession({ env: fake.env });
  session.start({ title: 'A', artist: 'x' });
  await flush();
  session.finish({ title: 'Taglio completato', artist: '4 parti pronte' });
  await flush();
  const [audio] = fake.created;
  assert.equal(audio.paused, true);
  assert.equal(session.state(), 'finished');
  assert.equal(fake.mediaSession.metadata.title, 'Taglio completato');
  assert.equal(fake.mediaSession.playbackState, 'paused');
  // Toccare «play» sulla notifica a lavoro finito non fa ripartire il tono.
  fake.handlers.play?.();
  await flush();
  assert.equal(audio.paused, true);
  assert.equal(session.state(), 'off');
  assert.equal(audio.src, '');
  assert.equal(fake.mediaSession.metadata, null);
  assert.equal(fake.mediaSession.playbackState, 'none');
  assert.deepEqual(Object.keys(fake.handlers), []);
  assert.deepEqual(fake.revoked, ['blob:tone-0']);
});

test('sessione: clear durante il lavoro non lascia stati «interrupted» né URL aperti', async () => {
  const fake = fakeEnv();
  const states = [];
  const session = createBackgroundSession({ env: fake.env, onChange: (state) => states.push(state) });
  session.start({ title: 'A', artist: 'x' });
  await flush();
  session.clear();
  await flush();
  assert.equal(session.state(), 'off');
  assert.deepEqual(states, ['starting', 'running', 'off']);
  assert.equal(fake.revoked.length, 1);
  // Una nuova partenza crea un elemento nuovo e funziona.
  session.start({ title: 'B', artist: 'y' });
  await flush();
  assert.equal(session.state(), 'running');
  assert.equal(fake.created.length, 2);
});

test('sessione: senza Media Session il tono funziona lo stesso', async () => {
  const fake = fakeEnv();
  delete fake.env.navigator.mediaSession;
  const session = createBackgroundSession({ env: fake.env });
  session.start({ title: 'A', artist: 'x' });
  await flush();
  assert.equal(session.state(), 'running');
  session.finish({ title: 'fine', artist: '' });
  session.clear();
  assert.equal(session.state(), 'off');
});
