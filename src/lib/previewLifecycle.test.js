import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

async function componentFixture(t, file, target, dependencies = {}) {
  const effects = [];
  let refIndex = 0;
  const setters = [];
  const react = {
    forwardRef: (render) => render,
    useRef(value) { return { current: refIndex++ === 0 ? target : value }; },
    useState(value) { const values = []; setters.push(values); return [value, (next) => values.push(next)]; },
    useEffect(setup) { effects.push(setup); },
    useImperativeHandle() {},
    createElement() { return null; },
  };
  const descriptors = Object.fromEntries(['__previewReact', '__previewDependencies', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, '__previewReact', { configurable: true, value: react });
  Object.defineProperty(globalThis, '__previewDependencies', { configurable: true, value: dependencies });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone' } });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let source = await readFile(new URL(`../components/${file}`, import.meta.url), 'utf8');
  source = source.replace(/import \{([^}]+)\} from 'react';/, 'const {$1} = globalThis.__previewReact;');
  source = source.replace(/import (\w+) from 'wavesurfer[^']*';/g, 'const $1 = globalThis.__previewDependencies.$1;');
  source = source.replace(/from '\.\.\/lib\/device.js'/g, `from '${new URL('./device.js', import.meta.url).href}'`);
  const { code } = await transform(source, { loader: 'jsx', jsxFactory: 'globalThis.__previewReact.createElement' });
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`);
  const cleanups = [];
  return { module, setters, mount(props) {
    module[file.replace('.jsx', '')](props, null);
    effects.forEach((setup) => cleanups.push(setup()));
  }, cleanup() { cleanups.forEach((cleanup) => cleanup?.()); } };
}

test('native preview teardown releases the media source and playback', async (t) => {
  const audio = new EventTarget();
  audio.src = 'blob:large'; audio.pauseCalls = 0; audio.loadCalls = 0;
  audio.pause = () => { audio.pauseCalls += 1; };
  audio.load = () => { audio.loadCalls += 1; };
  audio.removeAttribute = (name) => { delete audio[name]; };
  const fixture = await componentFixture(t, 'NativeAudioPreview.jsx', audio);
  fixture.mount({ src: 'blob:large', playbackRate: 1 });
  fixture.cleanup();
  assert.equal(audio.pauseCalls, 1);
  assert.equal(audio.src, undefined);
  assert.equal(audio.loadCalls, 1);
});

function waveformDependencies() {
  let resolveLoad;
  let rejectLoad;
  const callbacks = new Map();
  const calls = [];
  const renderer = { render() { calls.push('render'); } };
  const instance = {
    getRenderer: () => renderer,
    on(event, callback) { callbacks.set(event, callback); },
    un(event) { callbacks.delete(event); },
    destroy() { calls.push('destroy'); },
    loadBlob(blob, peaks, duration) { calls.push({ blob, duration }); return new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; }); },
    getDuration: () => 1800,
    setPlaybackRate() {}, zoom() {},
  };
  const plugin = { create: () => ({ on() {}, getRegions: () => [] }) };
  return { instance, callbacks, calls, resolve() { renderer.render(); resolveLoad?.(); }, reject() { rejectLoad?.(new Error('decode failure')); },
    dependencies: { WaveSurfer: { create: (options) => { calls.push(options); return instance; } }, RegionsPlugin: plugin, TimelinePlugin: plugin, HoverPlugin: plugin } };
}

test('waveform uses original Blob and known duration without URL refetch', async (t) => {
  const dependency = waveformDependencies();
  const fixture = await componentFixture(t, 'WaveformEditor.jsx', { addEventListener() {}, removeEventListener() {} }, dependency.dependencies);
  const blob = new Blob(['audio']);
  fixture.mount({ src: 'blob:large', blob, duration: 1800, cuts: [], bookmarks: [], sampleRate: 3000, zoom: 0 });
  await Promise.resolve();
  assert.equal(dependency.calls[0].url, undefined);
  assert.equal(dependency.calls[1]?.blob, blob);
  assert.equal(dependency.calls[1]?.duration, 1800);
  fixture.cleanup(); dependency.resolve();
  await new Promise((resolve) => setImmediate(resolve));
});

test('failed reduced-rate decode cannot retry past the mobile memory budget', async (t) => {
  const dependency = waveformDependencies();
  const fixture = await componentFixture(t, 'WaveformEditor.jsx', { addEventListener() {}, removeEventListener() {} }, dependency.dependencies);
  const errors = [];
  fixture.mount({ src: 'blob:large', blob: new Blob(['audio']), duration: 1800, cuts: [], bookmarks: [], sampleRate: 3000, zoom: 0, onWaveformError: (error) => errors.push(error) });
  await Promise.resolve();
  dependency.callbacks.get('error')(new Error('decode failure'));
  assert.equal(errors.length, 1);
  fixture.cleanup(); dependency.reject();
  await new Promise((resolve) => setImmediate(resolve));
});

test('outstanding decode remains pending until it settles after teardown', async (t) => {
  const dependency = waveformDependencies();
  const fixture = await componentFixture(t, 'WaveformEditor.jsx', { addEventListener() {}, removeEventListener() {} }, dependency.dependencies);
  const pending = [];
  fixture.mount({ src: 'blob:large', blob: new Blob(['audio']), duration: 1800, cuts: [], bookmarks: [], sampleRate: 8000, zoom: 0, onDecodePending: (value) => pending.push(value) });
  await Promise.resolve();
  fixture.cleanup();
  assert.deepEqual(pending, [true]);
  dependency.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending, [true, false]);
  assert.equal(dependency.calls.includes('render'), false);
});
