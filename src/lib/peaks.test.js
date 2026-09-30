import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AAC_SAMPLE_RATES,
  PeakAccumulator,
  adtsHeader,
  adtsParamsFromAsc,
  computeWaveformPeaks,
  detectPeaksFormat,
  frameChunks,
  parseAdtsHeader,
  parseMp3Header,
  parseMp4AudioTrack,
  peaksPerSecondFor,
  mp3EncoderDelay,
} from './peaks.js';

const fixture = (name) => new Blob([readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url))]);

/** Decoder finto: restituisce un AudioBuffer con tanti campioni quanti ne dura il blocco. */
function fakeDecoder(frameParser, samplesPerFrame, value = 0.5) {
  const calls = [];
  const decode = async (arrayBuffer) => {
    const bytes = new Uint8Array(arrayBuffer);
    let frames = 0;
    for (let pos = 0; pos < bytes.length;) {
      const header = frameParser(bytes, pos);
      assert.ok(header, `fotogramma non valido a ${pos} di ${bytes.length}`);
      frames += 1;
      pos += header.length;
    }
    calls.push(frames);
    const length = Math.round((frames * samplesPerFrame * 8000) / 22050);
    const data = new Float32Array(length).fill(value);
    return { numberOfChannels: 1, length, sampleRate: 8000, getChannelData: () => data };
  };
  return { decode, calls };
}

test('peaks: one value per 10 ms, symmetric channel for WaveSurfer', () => {
  assert.equal(peaksPerSecondFor(60), 100);
  assert.ok(peaksPerSecondFor(6 * 3600) < 100);
  const acc = new PeakAccumulator(1, 10);
  const data = new Float32Array(1000);
  data[150] = -0.8; // 0,15 s → finestra 1
  data[990] = 0.3; // 0,99 s → finestra 9
  acc.add([data], 1000, 0);
  assert.ok(Math.abs(acc.values[1] - 0.8) < 1e-6);
  assert.ok(Math.abs(acc.values[9] - 0.3) < 1e-6);
  assert.equal(acc.values[0], 0);
  const channel = acc.toWaveSurferChannel();
  assert.equal(channel.length, 20);
  assert.ok(Math.abs(channel[2] - 0.8) < 1e-6 && Math.abs(channel[3] + 0.8) < 1e-6);
  // Campioni prima dell'inizio o dopo la fine non escono dall'array.
  acc.add([new Float32Array(100).fill(1)], 100, -0.5);
  acc.add([new Float32Array(100).fill(1)], 100, 0.95);
  assert.equal(acc.values[0], 1);
});

test('WAV: peaks straight from PCM without any decoder', async () => {
  const rate = 8000;
  const frames = rate * 2;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (pos, value) => [...value].forEach((ch, i) => { bytes[pos + i] = ch.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, frames * 4, true);
  // Forte solo sul canale destro tra 0,5 e 0,6 s.
  for (let f = rate / 2; f < rate * 0.6; f += 1) view.setInt16(44 + f * 4 + 2, 16384, true);
  const result = await computeWaveformPeaks(new Blob([bytes]), { durationSeconds: 2, decode: () => { throw new Error('no decode'); } });
  assert.equal(result.format, 'wav');
  const at = (seconds) => result.peaks[Math.floor(seconds * result.pps) * 2];
  assert.ok(Math.abs(at(0.55) - 0.5) < 1e-3);
  assert.equal(at(0.2), 0);
  assert.equal(at(1.5), 0);
});

test('MP3 frame headers give exact frame sizes', () => {
  const header = parseMp3Header(Uint8Array.of(0xff, 0xfb, 0x90, 0x00), 0); // MPEG1 L3 128k 44,1 kHz
  assert.deepEqual(header, { length: 417, samples: 1152, sampleRate: 44100 });
  assert.equal(parseMp3Header(Uint8Array.of(0xff, 0xfb, 0xf0, 0x00), 0), null); // bitrate non valido
  assert.equal(parseMp3Header(Uint8Array.of(0xff, 0xf1, 0x50, 0x80), 0), null); // è ADTS, non MP3
});

test('frame chunks never split a frame, skip junk and keep exact times across reads', async () => {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const id3 = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(7));
  const junk = new Uint8Array(33).fill(0x11);
  const parts = [id3];
  const framesTotal = 200;
  for (let i = 0; i < framesTotal; i += 1) {
    parts.push(frame);
    if (i === 90) parts.push(junk);
  }
  const blob = new Blob(parts);
  const chunks = [];
  for await (const chunk of frameChunks(blob, { parse: parseMp3Header, startOffset: 30, chunkSeconds: 1, readBytes: 1000 })) {
    chunks.push(chunk);
  }
  const frameSeconds = 1152 / 44100;
  let expectedStart = 0;
  let frames = 0;
  for (const chunk of chunks) {
    assert.equal(chunk.bytes.length % 417, 0, 'solo fotogrammi interi, niente spazzatura');
    const count = chunk.bytes.length / 417;
    assert.ok(Math.abs(chunk.startSeconds - expectedStart) < 1e-9);
    assert.ok(Math.abs(chunk.endSeconds - (expectedStart + count * frameSeconds)) < 1e-9);
    expectedStart = chunk.endSeconds;
    frames += count;
  }
  assert.equal(frames, framesTotal);
  assert.ok(chunks.length >= 5);
});

test('AAC config: LC and explicit HE-AAC map to a decodable ADTS header', () => {
  assert.deepEqual(adtsParamsFromAsc(Uint8Array.of(0x12, 0x10)), { profile: 1, rateIndex: 4, channelConfig: 2 });
  assert.deepEqual(adtsParamsFromAsc(Uint8Array.of(0x2b, 0x92, 0x08)), { profile: 1, rateIndex: 7, channelConfig: 2 });
  const header = adtsHeader({ profile: 1, rateIndex: 4, channelConfig: 2 }, 100);
  const parsed = parseAdtsHeader(Uint8Array.from([...header, ...new Array(100).fill(0)]), 0);
  assert.deepEqual(parsed, { length: 107, samples: 1024, sampleRate: AAC_SAMPLE_RATES[4] });
});

test('real M4A: sample tables read, every chunk rebuilt as valid ADTS with exact timing', async () => {
  const blob = fixture('tono-3s.m4a');
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  assert.equal(detectPeaksFormat(head), 'mp4');
  const whole = new Uint8Array(await blob.arrayBuffer());
  let moovAt = 0;
  for (let i = 0; i < whole.length - 4; i += 1) {
    if (whole[i] === 0x6d && whole[i + 1] === 0x6f && whole[i + 2] === 0x6f && whole[i + 3] === 0x76) { moovAt = i - 4; break; }
  }
  const size = new DataView(whole.buffer).getUint32(moovAt);
  const track = parseMp4AudioTrack(whole.subarray(moovAt, moovAt + size));
  assert.ok(track, 'traccia AAC trovata');
  assert.equal(track.adts.rateIndex, AAC_SAMPLE_RATES.indexOf(22050));
  assert.ok(Math.abs(track.starts[track.count] - 3) < 0.1, `durata ${track.starts[track.count]}`);
  // Priming dell'encoder letto dall'edit list: serve ad allineare la forma d'onda all'ascolto.
  assert.ok(Math.abs(track.primingSeconds - 1024 / 22050) < 1e-6, `priming ${track.primingSeconds}`);

  const { decode, calls } = fakeDecoder(parseAdtsHeader, 1024);
  const result = await computeWaveformPeaks(blob, { durationSeconds: 3, decode });
  assert.equal(result.format, 'mp4');
  assert.equal(calls.reduce((a, b) => a + b, 0), track.count, 'ogni campione AAC decodificato una volta');
  assert.equal(result.peaks.length, 600);
});

test('real MP3: decoded in whole-frame chunks, peaks cover the full duration', async () => {
  const blob = fixture('tono-3s.mp3');
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  assert.equal(detectPeaksFormat(head), 'mp3');
  const { decode, calls } = fakeDecoder(parseMp3Header, 1152 / 2);
  const progress = [];
  const result = await computeWaveformPeaks(blob, { durationSeconds: 3, decode, onProgress: (f) => progress.push(f) });
  assert.equal(result.format, 'mp3');
  assert.ok(calls.length >= 1);
  assert.equal(progress.at(-1), 1);
  const filled = result.peaks.filter((v, i) => i % 2 === 0 && v > 0).length;
  assert.ok(filled > 280, `finestre piene: ${filled}`);
});

test('unsupported formats and undecodable streams fall back to null', async () => {
  const ogg = new Blob([Uint8Array.from('OggS\0\0\0\0\0\0\0\0\0\0', (c) => c.charCodeAt(0))]);
  assert.equal(await computeWaveformPeaks(ogg, { durationSeconds: 10, decode: async () => { throw new Error('x'); } }), null);
  const mp3 = fixture('tono-3s.mp3');
  assert.equal(await computeWaveformPeaks(mp3, { durationSeconds: 3, decode: async () => { throw new Error('no mp3'); } }), null);
});

test('work pauses while the app is busy and stops on abort', async () => {
  const mp3 = fixture('tono-3s.mp3');
  let busy = true;
  const { decode, calls } = fakeDecoder(parseMp3Header, 576);
  const job = computeWaveformPeaks(mp3, { durationSeconds: 3, decode, isPaused: () => busy });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, 0, 'fermo durante l’export');
  busy = false;
  assert.ok(await job);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(computeWaveformPeaks(mp3, { durationSeconds: 3, decode, signal: controller.signal }));
});

test('MP3 encoder delay comes from the LAME tag (gapless alignment)', async () => {
  const bytes = new Uint8Array(await fixture('tono-3s.mp3').arrayBuffer());
  let first = 0;
  if (bytes[0] === 0x49) first = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  while (!parseMp3Header(bytes, first)) first += 1;
  assert.equal(mp3EncoderDelay(bytes, first), 576);
  const noTag = new Uint8Array(417);
  noTag.set([0xff, 0xfb, 0x90, 0x00]);
  assert.equal(mp3EncoderDelay(noTag, 0), 576);
});
