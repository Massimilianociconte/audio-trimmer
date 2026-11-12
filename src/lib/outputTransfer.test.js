import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTPUT_HINT_DIR,
  PING_TYPE,
  PONG_TYPE,
  TAKE_ENCODING,
  handleOutputMessage,
  installOutputPatches,
  outputHintPath,
  parseHintWrite,
  prepareTakeBytes,
  sanitizeHintBytes,
} from './outputTransfer.js';

const MiB = 1024 * 1024;

// Crescita MEMFS di Emscripten (riassunta): ×1,125 sopra 1 MiB, copia dei byte usati.
function emscriptenExpand(node, newCapacity) {
  const previous = node.contents ? node.contents.length : 0;
  if (previous >= newCapacity) return;
  const capacity = Math.max(newCapacity, (previous * (previous < MiB ? 2 : 1.125)) >>> 0);
  const old = node.contents;
  node.contents = new Uint8Array(capacity);
  if (node.usedBytes > 0) node.contents.set(old.subarray(0, node.usedBytes), 0);
}

function fakeCore() {
  const MEMFS = { calls: 0, expandFileStorage(node, capacity) { MEMFS.calls += 1; emscriptenExpand(node, capacity); } };
  const files = new Map();
  const heap = new Uint8Array(64);
  return {
    HEAPU8: heap,
    files,
    FS: {
      filesystems: { MEMFS },
      lookupPath(path) {
        const node = files.get(path);
        if (!node) throw new Error(`ENOENT ${path}`);
        return { node };
      },
      unlink(path) {
        if (!files.delete(path)) throw new Error('ENOENT');
      },
    },
  };
}

function write(MEMFS, node, chunk) {
  MEMFS.expandFileStorage(node, node.usedBytes + chunk.length);
  node.contents.set(chunk, node.usedBytes);
  node.usedBytes += chunk.length;
}

test('hint paths and sizes are sanitized', () => {
  assert.equal(outputHintPath('/out/parte-1.m4a'), `${OUTPUT_HINT_DIR}parte-1.m4a`);
  assert.equal(outputHintPath('parte.mp3'), `${OUTPUT_HINT_DIR}parte.mp3`);
  assert.equal(sanitizeHintBytes(512 * 1024), 0);
  assert.equal(sanitizeHintBytes(2 * 1024 * MiB), 0);
  assert.equal(sanitizeHintBytes('abc'), 0);
  assert.equal(sanitizeHintBytes(NaN), 0);
  assert.equal(sanitizeHintBytes(10.2 * MiB), Math.ceil(10.2 * MiB));
});

test('hint writes are parsed only inside the control directory', () => {
  assert.equal(parseHintWrite({ path: '/out.m4a', data: new Uint8Array(1) }), null);
  assert.equal(parseHintWrite(null), null);
  assert.deepEqual(parseHintWrite({ path: `${OUTPUT_HINT_DIR}a/b`, data: '5' }), { name: '', bytes: 0 });
  assert.deepEqual(
    parseHintWrite({ path: `${OUTPUT_HINT_DIR}out.m4a`, data: new TextEncoder().encode(String(20 * MiB)) }),
    { name: 'out.m4a', bytes: 20 * MiB },
  );
  assert.deepEqual(parseHintWrite({ path: `${OUTPUT_HINT_DIR}out.m4a`, data: 'nope' }), { name: 'out.m4a', bytes: 0 });
});

test('a hinted output is allocated once and keeps identical bytes', () => {
  const core = fakeCore();
  const hints = new Map([['out.m4a', 6 * MiB]]);
  const MEMFS = core.FS.filesystems.MEMFS;
  assert.equal(installOutputPatches(core, hints), true);
  assert.equal(installOutputPatches(core, hints), true, 'idempotente');

  const hinted = { name: 'out.m4a', contents: null, usedBytes: 0 };
  const plain = { name: 'other.m4a', contents: null, usedBytes: 0 };
  const chunk = new Uint8Array(256 * 1024).map((_, index) => index % 251);
  const buffers = new Set();
  for (let i = 0; i < 20; i += 1) {
    write(MEMFS, hinted, chunk);
    buffers.add(hinted.contents.buffer);
    write(MEMFS, plain, chunk);
  }
  assert.equal(buffers.size, 1, 'una sola allocazione per il file con hint');
  assert.equal(hinted.contents.length, 6 * MiB);
  assert.equal(hinted.usedBytes, plain.usedBytes);
  assert.deepEqual(hinted.contents.subarray(0, hinted.usedBytes), plain.contents.subarray(0, plain.usedBytes));
});

test('an output larger than its hint falls back to the original growth', () => {
  const core = fakeCore();
  const hints = new Map([['out.m4a', 2 * MiB]]);
  const MEMFS = core.FS.filesystems.MEMFS;
  installOutputPatches(core, hints);
  const node = { name: 'out.m4a', contents: null, usedBytes: 0 };
  const chunk = new Uint8Array(MiB).fill(7);
  write(MEMFS, node, chunk);
  write(MEMFS, node, chunk);
  assert.equal(node.contents.length, 2 * MiB);
  write(MEMFS, node, chunk);
  assert.ok(node.contents.length >= 3 * MiB);
  assert.equal(node.usedBytes, 3 * MiB);
  assert.ok(node.contents.subarray(0, node.usedBytes).every((value) => value === 7));
});

test('patching is skipped when the core does not expose MEMFS', () => {
  assert.equal(installOutputPatches(null, new Map()), false);
  assert.equal(installOutputPatches({ FS: { filesystems: {} } }, new Map()), false);
  assert.equal(installOutputPatches(fakeCore(), {}), false);
});

test('take bytes: zero-copy view only when it is safe', () => {
  const exact = new Uint8Array(4 * MiB);
  assert.equal(prepareTakeBytes(exact, exact.length), exact);

  const smallWaste = new Uint8Array(4 * MiB);
  const view = prepareTakeBytes(smallWaste, 4 * MiB - 1000);
  assert.equal(view.buffer, smallWaste.buffer);
  assert.equal(view.byteLength, 4 * MiB - 1000);

  // Capacità molto oltre i byte usati: copia esatta, niente spazio morto trasferito.
  const bigWaste = new Uint8Array(40 * MiB);
  const copy = prepareTakeBytes(bigWaste, 4 * MiB);
  assert.notEqual(copy.buffer, bigWaste.buffer);
  assert.equal(copy.byteLength, 4 * MiB);

  // Mai il buffer della memoria wasm, mai una vista con offset.
  const heap = new Uint8Array(8 * MiB);
  const inHeap = heap.subarray(0, 8 * MiB);
  assert.notEqual(prepareTakeBytes(inHeap, 8 * MiB, heap.buffer).buffer, heap.buffer);
  const offset = new Uint8Array(new ArrayBuffer(2 * MiB), 16, MiB);
  assert.notEqual(prepareTakeBytes(offset, MiB).buffer, offset.buffer);

  assert.equal(prepareTakeBytes(null, 10).byteLength, 0);
  assert.equal(prepareTakeBytes(exact, 0).byteLength, 0);
  assert.deepEqual(prepareTakeBytes([1, 2, 3, 4], 3), new Uint8Array([1, 2, 3]));
});

test('ping is answered before the engine is loaded', () => {
  const posted = [];
  assert.equal(handleOutputMessage({ id: 1, type: PING_TYPE }, { core: null, hints: new Map(), post: (m) => posted.push(m) }), true);
  assert.deepEqual(posted, [{ id: 1, type: PONG_TYPE, data: true }]);
  assert.equal(handleOutputMessage({ id: 2, type: 'READ_FILE', data: { path: '/x', encoding: TAKE_ENCODING } }, { core: null, hints: new Map(), post: () => {} }), false);
});

test('hint writes set and clear hints; other messages go to the library', () => {
  const core = fakeCore();
  const hints = new Map();
  const posted = [];
  const ctx = { core, hints, post: (m) => posted.push(m) };
  const size = new TextEncoder().encode(String(8 * MiB));
  assert.equal(handleOutputMessage({ id: 1, type: 'WRITE_FILE', data: { path: outputHintPath('out.m4a'), data: size } }, ctx), true);
  assert.equal(hints.get('out.m4a'), 8 * MiB);
  assert.equal(handleOutputMessage({ id: 2, type: 'WRITE_FILE', data: { path: outputHintPath('out.m4a'), data: '0' } }, ctx), true);
  assert.equal(hints.has('out.m4a'), false);
  assert.deepEqual(posted.map((m) => [m.id, m.type, m.data]), [[1, 'WRITE_FILE', true], [2, 'WRITE_FILE', true]]);

  assert.equal(handleOutputMessage({ id: 3, type: 'WRITE_FILE', data: { path: '/out.m4a', data: new Uint8Array(1) } }, ctx), false);
  assert.equal(handleOutputMessage({ id: 4, type: 'READ_FILE', data: { path: '/out.m4a' } }, ctx), false);
  assert.equal(handleOutputMessage({ id: 5, type: 'EXEC', data: {} }, ctx), false);
});

test('take read transfers the file bytes and removes the virtual file', () => {
  const core = fakeCore();
  const hints = new Map([['out.m4a', 4 * MiB]]);
  const contents = new Uint8Array(4 * MiB).map((_, index) => index % 13);
  core.files.set('/out.m4a', { name: 'out.m4a', contents, usedBytes: 4 * MiB - 10 });
  const posted = [];
  const handled = handleOutputMessage(
    { id: 9, type: 'READ_FILE', data: { path: '/out.m4a', encoding: TAKE_ENCODING } },
    { core, hints, post: (message, transfer) => posted.push({ message, transfer }) },
  );
  assert.equal(handled, true);
  assert.equal(posted.length, 1);
  const { message, transfer } = posted[0];
  assert.equal(message.id, 9);
  assert.equal(message.type, 'READ_FILE');
  assert.equal(message.data.byteLength, 4 * MiB - 10);
  assert.deepEqual(transfer, [message.data.buffer]);
  assert.equal(message.data[12], 12);
  assert.equal(core.files.has('/out.m4a'), false);
  assert.equal(hints.has('out.m4a'), false);
});

test('take read errors become an ERROR reply so the app falls back', () => {
  const core = fakeCore();
  const posted = [];
  handleOutputMessage(
    { id: 3, type: 'READ_FILE', data: { path: '/missing.m4a', encoding: TAKE_ENCODING } },
    { core, hints: new Map(), post: (message) => posted.push(message) },
  );
  assert.equal(posted[0].type, 'ERROR');
  assert.equal(posted[0].id, 3);
  assert.match(posted[0].data, /ENOENT/);
});

test('a failed transfer keeps the file for the classic read', () => {
  const core = fakeCore();
  core.files.set('/out.m4a', { name: 'out.m4a', contents: new Uint8Array(4), usedBytes: 4 });
  let calls = 0;
  const post = (message) => {
    calls += 1;
    if (calls === 1) throw new Error('DataCloneError');
  };
  handleOutputMessage({ id: 1, type: 'READ_FILE', data: { path: '/out.m4a', encoding: TAKE_ENCODING } }, { core, hints: new Map(), post });
  assert.equal(core.files.has('/out.m4a'), true);
});
