/**
 * Forma d'onda a memoria costante per file lunghi (telefoni, tablet, PC deboli).
 *
 * decodeAudioData sull'intero file alloca tutto il PCM (una lezione di 1 h
 * = oltre 1 GB con lo staging del decoder): sui mobile uccide la scheda, per
 * questo i file lunghi finivano sull'anteprima senza forma d'onda. Qui il file
 * si legge a blocchi di ~60 s, ognuno decodificato e subito ridotto a picchi:
 * picco di memoria ~50 MB qualunque sia la durata.
 *
 * - WAV: PCM letto direttamente, nessuna decodifica.
 * - MP3 / AAC (ADTS): blocchi tagliati sui confini dei fotogrammi, tempi esatti
 *   contati in fotogrammi (niente deriva sui file VBR).
 * - M4A/MP4 (AAC): tabelle dei campioni lette dal moov, ogni campione
 *   impacchettato in ADTS in JavaScript (nessun motore FFmpeg necessario).
 * Altri formati: null → resta l'anteprima nativa.
 */

export const MAX_PEAK_WINDOWS = 1_500_000;
const READ_BYTES = 4 * 1024 * 1024;
const CHUNK_SECONDS = 60;

const MP3_BITRATES = {
  // [versione MPEG1][layer III] e [MPEG2/2.5][layer III], kbps
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
export const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Picchi al secondo: 100 (una barra ogni 10 ms), meno solo oltre ~4 ore. */
export function peaksPerSecondFor(durationSeconds) {
  const duration = Math.max(1, Number(durationSeconds) || 1);
  return Math.max(10, Math.min(100, Math.floor(MAX_PEAK_WINDOWS / duration)));
}

export class PeakAccumulator {
  constructor(durationSeconds, pps = peaksPerSecondFor(durationSeconds)) {
    this.pps = pps;
    this.windows = Math.max(1, Math.ceil(Math.max(0, Number(durationSeconds) || 0) * pps));
    this.values = new Float32Array(this.windows);
  }

  /**
   * channels[c][offset + k] suona a startSeconds + k / sampleRate.
   * Campioni prima di 0 o oltre la durata vengono ignorati.
   */
  add(channels, sampleRate, startSeconds, offset = 0, count = channels[0].length - offset) {
    const { pps, values, windows } = this;
    let k = 0;
    if (startSeconds < 0) {
      k = Math.min(count, Math.ceil(-startSeconds * sampleRate));
    }
    while (k < count) {
      const w = Math.floor((startSeconds + k / sampleRate) * pps);
      if (w >= windows) break;
      let end = Math.ceil(((w + 1) / pps - startSeconds) * sampleRate);
      if (end <= k) end = k + 1;
      if (end > count) end = count;
      let max = values[w];
      for (let c = 0; c < channels.length; c += 1) {
        const data = channels[c];
        for (let j = offset + k; j < offset + end; j += 1) {
          const value = data[j];
          const abs = value < 0 ? -value : value;
          if (abs > max) max = abs;
        }
      }
      values[w] = max;
      k = end;
    }
  }

  /** Canale unico con picchi +p/−p alternati: WaveSurfer disegna barre simmetriche. */
  toWaveSurferChannel() {
    const out = new Float32Array(this.windows * 2);
    for (let i = 0; i < this.windows; i += 1) {
      out[i * 2] = this.values[i];
      out[i * 2 + 1] = -this.values[i];
    }
    return out;
  }
}

function ascii(bytes, start, length) {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[start + i] ?? 0);
  return text;
}

function id3Size(bytes) {
  if (ascii(bytes, 0, 3) !== 'ID3' || bytes.length < 10) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
}

/** Intestazione di un fotogramma MP3 layer III, oppure null. */
export function parseMp3Header(bytes, pos) {
  if (pos + 4 > bytes.length) return null;
  const b1 = bytes[pos + 1];
  const b2 = bytes[pos + 2];
  if (bytes[pos] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b1 >> 1) & 3; // 1 = layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIndex];
  const sampleRate = MP3_SAMPLE_RATES[version][rateIndex];
  const padding = (b2 >> 1) & 1;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + padding;
  if (length < 24) return null;
  return { length, samples, sampleRate };
}

/**
 * Ritardo dell'encoder MP3 dal tag LAME/Info del primo fotogramma (campioni).
 * Senza tag si assume quello standard di LAME (576).
 */
export function mp3EncoderDelay(bytes, framePos) {
  const header = parseMp3Header(bytes, framePos);
  const end = header ? Math.min(bytes.length, framePos + header.length) : Math.min(bytes.length, framePos + 400);
  for (let pos = framePos + 4; pos + 24 <= end; pos += 1) {
    const tag = ascii(bytes, pos, 4);
    if (tag === 'LAME' || tag === 'Lavc' || tag === 'Lavf') {
      const delay = (bytes[pos + 21] << 4) | (bytes[pos + 22] >> 4);
      return delay > 0 && delay < 4096 ? delay : 576;
    }
  }
  return 576;
}

/** Intestazione ADTS (AAC), oppure null. */
export function parseAdtsHeader(bytes, pos) {
  if (pos + 7 > bytes.length) return null;
  const b1 = bytes[pos + 1];
  if (bytes[pos] !== 0xff || (b1 & 0xf6) !== 0xf0) return null;
  const rateIndex = (bytes[pos + 2] >> 2) & 0x0f;
  const sampleRate = AAC_SAMPLE_RATES[rateIndex];
  if (!sampleRate) return null;
  const length = ((bytes[pos + 3] & 0x03) << 11) | (bytes[pos + 4] << 3) | (bytes[pos + 5] >> 5);
  const blocks = (bytes[pos + 6] & 0x03) + 1;
  if (length < 7) return null;
  return { length, samples: 1024 * blocks, sampleRate };
}

/** Riconosce il formato dai primi byte (non dall'estensione, spesso sbagliata). */
export function detectPeaksFormat(head) {
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav';
  if (ascii(head, 4, 4) === 'ftyp') return 'mp4';
  const start = id3Size(head);
  for (let pos = start; pos < Math.min(head.length - 8, start + 16384); pos += 1) {
    if (head[pos] !== 0xff) continue;
    const mp3 = parseMp3Header(head, pos);
    if (mp3 && parseMp3Header(head, pos + mp3.length)) return 'mp3';
    const adts = parseAdtsHeader(head, pos);
    if (adts && parseAdtsHeader(head, pos + adts.length)) return 'adts';
  }
  return null;
}

async function readRange(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// ---------------------------------------------------------------- WAV

export function parseWavHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let format = null;
  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      let audioFormat = view.getUint16(pos + 8, true);
      if (audioFormat === 0xfffe && size >= 26) audioFormat = view.getUint16(pos + 32, true);
      format = {
        audioFormat,
        channels: view.getUint16(pos + 10, true),
        sampleRate: view.getUint32(pos + 12, true),
        blockAlign: view.getUint16(pos + 20, true),
        bitsPerSample: view.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      if (!format) return null;
      const supported = (format.audioFormat === 1 && [8, 16, 24, 32].includes(format.bitsPerSample))
        || (format.audioFormat === 3 && format.bitsPerSample === 32);
      if (!supported || !format.channels || !format.sampleRate || !format.blockAlign) return null;
      return { ...format, dataOffset: pos + 8, dataSize: size };
    }
    pos += 8 + size + (size & 1);
  }
  return null;
}

function wavFramesToMono(bytes, info) {
  const { channels, blockAlign, bitsPerSample, audioFormat } = info;
  const frames = Math.floor(bytes.length / blockAlign);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(frames);
  const step = bitsPerSample / 8;
  for (let f = 0; f < frames; f += 1) {
    let max = 0;
    for (let c = 0; c < channels; c += 1) {
      const p = f * blockAlign + c * step;
      let value;
      if (audioFormat === 3) value = view.getFloat32(p, true);
      else if (bitsPerSample === 16) value = view.getInt16(p, true) / 32768;
      else if (bitsPerSample === 24) value = (((bytes[p + 2] << 24) | (bytes[p + 1] << 16) | (bytes[p] << 8)) >> 8) / 8388608;
      else if (bitsPerSample === 32) value = view.getInt32(p, true) / 2147483648;
      else value = (bytes[p] - 128) / 128;
      const abs = value < 0 ? -value : value;
      if (abs > max) max = abs;
    }
    out[f] = max;
  }
  return out;
}

// ------------------------------------------------ MP3 / ADTS: blocchi di fotogrammi

/**
 * Taglia uno stream di fotogrammi in blocchi da ~60 s interi (mai a metà
 * fotogramma). Ogni blocco ha tempo di inizio/fine esatto in fotogrammi.
 */
export async function* frameChunks(blob, { parse, startOffset = 0, chunkSeconds = CHUNK_SECONDS, readBytes = READ_BYTES, signal, preRollFrames = 0 } = {}) {
  let fileOffset = startOffset;
  // Gli ultimi fotogrammi del blocco precedente, ridecodificati in testa al
  // successivo: il decoder "si scalda" su quelli (overlap AAC, bit reservoir MP3).
  let preRoll = new Uint8Array(0);
  const recentLengths = [];
  let carry = new Uint8Array(0);
  let elapsedSamples = 0;
  let sampleRate = 0;
  let pending = [];
  let pendingSamples = 0;
  let pendingStartSamples = 0;

  const flush = () => {
    if (!pending.length) return null;
    const total = pending.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(preRoll.length + total);
    bytes.set(preRoll);
    let at = preRoll.length;
    for (const part of pending) {
      bytes.set(part, at);
      at += part.length;
    }
    const tail = recentLengths.reduce((sum, length) => sum + length, 0);
    preRoll = bytes.slice(Math.max(preRoll.length, bytes.length - tail));
    const chunk = {
      bytes,
      startSeconds: pendingStartSamples / sampleRate,
      endSeconds: (pendingStartSamples + pendingSamples) / sampleRate,
      fileOffset,
    };
    pending = [];
    pendingStartSamples = elapsedSamples;
    pendingSamples = 0;
    return chunk;
  };

  while (fileOffset < blob.size || carry.length) {
    signal?.throwIfAborted?.();
    const next = fileOffset < blob.size ? await readRange(blob, fileOffset, Math.min(blob.size, fileOffset + readBytes)) : new Uint8Array(0);
    fileOffset += next.length;
    const buffer = new Uint8Array(carry.length + next.length);
    buffer.set(carry);
    buffer.set(next, carry.length);
    const atEnd = fileOffset >= blob.size;
    let pos = 0;
    let runStart = -1;
    while (pos < buffer.length) {
      const header = parse(buffer, pos);
      const complete = header && pos + header.length <= buffer.length;
      if (!header || (!complete && atEnd)) {
        // Byte estranei (tag, spazzatura): cerca il prossimo sincronismo.
        if (runStart >= 0) pending.push(buffer.subarray(runStart, pos));
        runStart = -1;
        if (!header && pos + 8 > buffer.length && !atEnd) break;
        pos += 1;
        continue;
      }
      if (!complete) break;
      if (sampleRate && header.sampleRate !== sampleRate) {
        pos += 1;
        continue;
      }
      sampleRate = header.sampleRate;
      if (runStart < 0) runStart = pos;
      if (preRollFrames > 0) {
        recentLengths.push(header.length);
        if (recentLengths.length > preRollFrames) recentLengths.shift();
      }
      pos += header.length;
      elapsedSamples += header.samples;
      pendingSamples += header.samples;
      if (pendingSamples >= chunkSeconds * sampleRate) {
        pending.push(buffer.slice(runStart, pos));
        runStart = -1;
        const chunk = flush();
        if (chunk) yield chunk;
      }
    }
    if (runStart >= 0) pending.push(buffer.slice(runStart, Math.min(pos, buffer.length)));
    carry = pos < buffer.length && !atEnd ? buffer.slice(pos) : new Uint8Array(0);
    if (atEnd && fileOffset >= blob.size && !carry.length) break;
  }
  const last = flush();
  if (last) yield { ...last, final: true };
}

// ---------------------------------------------------------------- MP4 / M4A

function readBoxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = ascii(bytes, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    boxes.push({ type, start: pos, content: pos + header, end: pos + size });
    pos += size;
  }
  return boxes;
}

function child(bytes, box, type) {
  return readBoxes(bytes, box.content, box.end).find((item) => item.type === type) ?? null;
}

function childPath(bytes, box, path) {
  let current = box;
  for (const type of path) {
    current = current && child(bytes, current, type);
  }
  return current;
}

/** Trova il box moov leggendo solo le intestazioni dei box di primo livello. */
async function readMoov(blob) {
  let pos = 0;
  while (pos + 8 <= blob.size) {
    const head = await readRange(blob, pos, Math.min(blob.size, pos + 16));
    const view = new DataView(head.buffer);
    let size = view.getUint32(0);
    const type = ascii(head, 4, 4);
    if (size === 1 && head.length >= 16) size = Number(view.getBigUint64(8));
    else if (size === 0) size = blob.size - pos;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) return null;
      return readRange(blob, pos, pos + size);
    }
    pos += size;
  }
  return null;
}

function parseEsdsAsc(bytes, esds) {
  // ES_Descriptor (0x03) → DecoderConfig (0x04) → DecoderSpecificInfo (0x05)
  let pos = esds.content + 4;
  const readLength = () => {
    let length = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = bytes[pos];
      pos += 1;
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return length;
  };
  while (pos < esds.end) {
    const tag = bytes[pos];
    pos += 1;
    const length = readLength();
    if (tag === 0x03) {
      const flags = bytes[pos + 2];
      pos += 3;
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) pos += 1 + bytes[pos];
      if (flags & 0x20) pos += 2;
    } else if (tag === 0x04) {
      if (bytes[pos] !== 0x40 && bytes[pos] !== 0x67 && bytes[pos] !== 0x66) return null; // solo AAC
      pos += 13;
    } else if (tag === 0x05) {
      return bytes.subarray(pos, pos + length);
    } else {
      pos += length;
    }
  }
  return null;
}

/** AudioSpecificConfig → parametri dell'intestazione ADTS (AAC LC/HE). */
export function adtsParamsFromAsc(asc) {
  if (!asc || asc.length < 2) return null;
  let bitPos = 0;
  const bits = (count) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = asc[bitPos >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos += 1;
    }
    return value;
  };
  let aot = bits(5);
  if (aot === 31) aot = 32 + bits(6);
  const rateIndex = bits(4);
  if (rateIndex === 15) return null;
  const channelConfig = bits(4);
  if (aot === 5 || aot === 29) {
    // HE-AAC esplicito: ADTS porta il core LC, il decoder ricostruisce l'SBR.
    const extensionIndex = bits(4);
    if (extensionIndex === 15) bits(24);
    aot = bits(5);
  }
  if (aot < 1 || aot > 4 || !channelConfig || !AAC_SAMPLE_RATES[rateIndex]) return null;
  return { profile: aot - 1, rateIndex, channelConfig };
}

export function adtsHeader({ profile, rateIndex, channelConfig }, payloadLength) {
  const length = payloadLength + 7;
  return Uint8Array.of(
    0xff,
    0xf1,
    (profile << 6) | (rateIndex << 2) | (channelConfig >> 2),
    ((channelConfig & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
  );
}

/** Tabelle dei campioni AAC della prima traccia audio: offset, dimensioni, tempi. */
export function parseMp4AudioTrack(moov) {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root = { content: 8, end: moov.length };
  for (const trak of readBoxes(moov, root.content, root.end).filter((box) => box.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!hdlr || ascii(moov, hdlr.content + 8, 4) !== 'soun') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    const stbl = childPath(moov, mdia, ['minf', 'stbl']);
    if (!mdhd || !stbl) return null;
    const mdhdVersion = moov[mdhd.content];
    const timescale = view.getUint32(mdhd.content + (mdhdVersion === 1 ? 20 : 12));
    const stsd = child(moov, stbl, 'stsd');
    const entry = stsd && readBoxes(moov, stsd.content + 8, stsd.end)[0];
    if (!entry || entry.type !== 'mp4a') return null;
    const esds = readBoxes(moov, entry.content + 28, entry.end).find((box) => box.type === 'esds');
    const adts = esds && adtsParamsFromAsc(parseEsdsAsc(moov, esds));
    if (!adts) return null;

    const stsz = child(moov, stbl, 'stsz');
    const stsc = child(moov, stbl, 'stsc');
    const stco = child(moov, stbl, 'stco') ?? child(moov, stbl, 'co64');
    const stts = child(moov, stbl, 'stts');
    if (!stsz || !stsc || !stco || !stts) return null;
    const fixedSize = view.getUint32(stsz.content + 4);
    const count = view.getUint32(stsz.content + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) sizes[i] = fixedSize || view.getUint32(stsz.content + 12 + i * 4);

    const is64 = stco.type === 'co64';
    const chunkCount = view.getUint32(stco.content + 4);
    const chunkOffset = (i) => (is64
      ? Number(view.getBigUint64(stco.content + 8 + i * 8))
      : view.getUint32(stco.content + 8 + i * 4));
    const offsets = new Float64Array(count);
    const runs = view.getUint32(stsc.content + 4);
    let sample = 0;
    for (let r = 0; r < runs && sample < count; r += 1) {
      const base = stsc.content + 8 + r * 12;
      const firstChunk = view.getUint32(base) - 1;
      const perChunk = view.getUint32(base + 4);
      const nextFirst = r + 1 < runs ? view.getUint32(base + 12) - 1 : chunkCount;
      for (let c = firstChunk; c < nextFirst && sample < count; c += 1) {
        let offset = chunkOffset(c);
        for (let s = 0; s < perChunk && sample < count; s += 1) {
          offsets[sample] = offset;
          offset += sizes[sample];
          sample += 1;
        }
      }
    }

    const starts = new Float64Array(count + 1);
    const entries = view.getUint32(stts.content + 4);
    let at = 0;
    let t = 0;
    for (let e = 0; e < entries && at < count; e += 1) {
      const n = view.getUint32(stts.content + 8 + e * 8);
      const delta = view.getUint32(stts.content + 12 + e * 8);
      for (let i = 0; i < n && at < count; i += 1) {
        starts[at] = t / timescale;
        t += delta;
        at += 1;
      }
    }
    for (; at <= count; at += 1) starts[at] = t / timescale;
    // Priming dell'encoder (1024 FFmpeg, 2112 Apple/iPhone) dall'edit list.
    let primingSeconds = 1024 / AAC_SAMPLE_RATES[adts.rateIndex];
    const elst = childPath(moov, trak, ['edts', 'elst']);
    if (elst) {
      const version = moov[elst.content];
      const entries = view.getUint32(elst.content + 4);
      for (let e = 0; e < entries; e += 1) {
        const base = elst.content + 8 + e * (version === 1 ? 20 : 12);
        const mediaTime = version === 1
          ? Number(view.getBigInt64(base + 8))
          : view.getInt32(base + 4);
        if (mediaTime >= 0) {
          primingSeconds = mediaTime / timescale;
          break;
        }
      }
    }
    return { adts, sizes, offsets, starts, count, primingSeconds };
  }
  return null;
}

async function* mp4Chunks(blob, track, { chunkSeconds = CHUNK_SECONDS, signal, preRollFrames = 0 } = {}) {
  const { adts, sizes, offsets, starts, count } = track;
  let first = 0;
  while (first < count) {
    signal?.throwIfAborted?.();
    let last = first;
    while (last < count && starts[last] - starts[first] < chunkSeconds) last += 1;
    const from = Math.max(0, first - preRollFrames);
    // Una sola lettura per blocco quando i campioni sono contigui (m4a audio).
    let lo = Infinity;
    let hi = 0;
    let payload = 0;
    for (let i = from; i < last; i += 1) {
      lo = Math.min(lo, offsets[i]);
      hi = Math.max(hi, offsets[i] + sizes[i]);
      payload += sizes[i];
    }
    const out = new Uint8Array(payload + (last - from) * 7);
    let at = 0;
    const append = (data, i) => {
      out.set(adtsHeader(adts, sizes[i]), at);
      out.set(data, at + 7);
      at += 7 + sizes[i];
    };
    if (hi - lo <= payload * 2 + 65536) {
      const span = await readRange(blob, lo, hi);
      for (let i = from; i < last; i += 1) append(span.subarray(offsets[i] - lo, offsets[i] - lo + sizes[i]), i);
    } else {
      for (let i = from; i < last; i += 1) append(await readRange(blob, offsets[i], offsets[i] + sizes[i]), i);
    }
    // L'ultimo campione ha spesso una durata accorciata nell'stts (padding
    // dell'encoder) ma il decoder restituisce il fotogramma intero: per
    // l'allineamento conta la durata piena.
    const alignEndSeconds = last >= count && last - first >= 2
      ? starts[last - 1] + (starts[last - 1] - starts[last - 2])
      : starts[last];
    yield { bytes: out, startSeconds: starts[first], endSeconds: starts[last], alignEndSeconds, fileOffset: hi, final: last >= count };
    first = last;
  }
}

// ------------------------------------------------------------------ Entrata

function defaultDecoder(env = globalThis) {
  const Ctx = env.OfflineAudioContext || env.webkitOfflineAudioContext;
  if (typeof Ctx !== 'function') return null;
  let context = null;
  return (arrayBuffer) => {
    context ??= new Ctx(1, 1, 8000);
    return new Promise((resolve, reject) => {
      const done = context.decodeAudioData(arrayBuffer, resolve, reject);
      if (done && typeof done.then === 'function') done.then(resolve, reject);
    });
  };
}

function waitWhilePaused(isPaused, signal) {
  if (!isPaused?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer);
        reject(signal.reason ?? new DOMException('Annullato', 'AbortError'));
      } else if (!isPaused()) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Picchi della forma d'onda di un File/Blob, a memoria costante.
 * Ritorna { peaks, pps, format } oppure null se il formato non è gestito.
 * `isPaused()` sospende il lavoro (es. durante un export, per non sommare i picchi di RAM).
 */
export async function computeWaveformPeaks(blob, {
  durationSeconds,
  signal,
  onProgress,
  isPaused,
  decode = defaultDecoder(),
  pps,
} = {}) {
  const duration = Number(durationSeconds);
  if (!blob?.size || !Number.isFinite(duration) || duration <= 0) return null;
  const head = await readRange(blob, 0, Math.min(blob.size, 65536));
  const format = detectPeaksFormat(head);
  if (!format) return null;
  const acc = new PeakAccumulator(duration, pps ?? peaksPerSecondFor(duration));
  const report = (offset) => {
    try {
      onProgress?.(Math.min(1, offset / blob.size));
    } catch {
      // il progresso non deve mai fermare il calcolo
    }
  };

  if (format === 'wav') {
    const info = parseWavHeader(head);
    if (!info) return null;
    const end = Math.min(blob.size, info.dataOffset + (info.dataSize || blob.size));
    const slice = Math.max(info.blockAlign, Math.floor(READ_BYTES / info.blockAlign) * info.blockAlign);
    let frame = 0;
    for (let pos = info.dataOffset; pos < end; pos += slice) {
      signal?.throwIfAborted?.();
      await waitWhilePaused(isPaused, signal);
      const mono = wavFramesToMono(await readRange(blob, pos, Math.min(end, pos + slice)), info);
      acc.add([mono], info.sampleRate, frame / info.sampleRate);
      frame += mono.length;
      report(pos + slice);
      await yieldToUi();
    }
    return { peaks: acc.toWaveSurferChannel(), pps: acc.pps, format };
  }

  if (typeof decode !== 'function') return null;
  let chunks;
  // Un blocco decodificato da solo conserva il ritardo di codifica che la
  // decodifica integrale scarta (metadati gapless): lo si compensa, così la
  // forma d'onda coincide con l'ascolto (misurato: 0 ms di scarto su Chromium).
  let latencySeconds = 0;
  // L'ultimo fotogramma decodificato di un blocco non ha il successivo con cui
  // annullare l'aliasing della trasformata (TDAC): lo si scarta e lo copre il
  // blocco dopo, che lo decodifica nel suo pre-roll.
  let frameSeconds = 0;
  if (format === 'mp4') {
    const moov = await readMoov(blob);
    const track = moov && parseMp4AudioTrack(moov);
    if (!track) return null;
    latencySeconds = track.primingSeconds;
    frameSeconds = 1024 / AAC_SAMPLE_RATES[track.adts.rateIndex];
    chunks = mp4Chunks(blob, track, { signal, preRollFrames: 3 });
  } else {
    const startOffset = format === 'mp3' ? id3Size(head) : 0;
    if (format === 'mp3') {
      let first = startOffset;
      while (first < head.length - 4 && !parseMp3Header(head, first)) first += 1;
      const frame = parseMp3Header(head, first);
      if (frame) {
        // ritardo encoder + 529 del decoder + un fotogramma trattenuto dal decoder
        latencySeconds = (mp3EncoderDelay(head, first) + 529 + frame.samples) / frame.sampleRate;
        frameSeconds = frame.samples / frame.sampleRate;
      }
    } else {
      const frame = parseAdtsHeader(head, 0);
      if (frame) {
        // AAC grezzo: nessun metadato gapless, il browser non scarta il priming
        // né in ascolto né in decodifica. Nessuna compensazione.
        latencySeconds = 0;
        frameSeconds = frame.samples / frame.sampleRate;
      }
    }
    chunks = frameChunks(blob, {
      parse: format === 'mp3' ? parseMp3Header : parseAdtsHeader,
      startOffset,
      signal,
      preRollFrames: format === 'mp3' ? 4 : 3,
    });
  }

  let decodedAny = false;
  for await (const chunk of chunks) {
    signal?.throwIfAborted?.();
    await waitWhilePaused(isPaused, signal);
    let audio;
    try {
      audio = await decode(chunk.bytes.buffer.slice(chunk.bytes.byteOffset, chunk.bytes.byteOffset + chunk.bytes.byteLength));
    } catch (error) {
      // Il primo blocco non decodificabile = formato non supportato da questo browser.
      if (!decodedAny) return null;
      continue;
    }
    decodedAny = true;
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c += 1) channels.push(audio.getChannelData(c));
    // Allineato sulla FINE esatta del blocco: eventuali campioni di avvio del
    // decoder all'inizio non spostano il resto della forma d'onda.
    const start = (chunk.alignEndSeconds ?? chunk.endSeconds) - audio.length / audio.sampleRate - latencySeconds;
    // Si tiene solo il tratto di competenza del blocco: il pre-roll l'ha già
    // dato il blocco precedente, l'ultimo fotogramma lo darà il successivo.
    const keepFrom = chunk.startSeconds - latencySeconds - frameSeconds;
    const keepTo = chunk.final ? Infinity : chunk.endSeconds - latencySeconds - frameSeconds;
    const skip = Math.max(0, Math.min(audio.length, Math.ceil((keepFrom - start) * audio.sampleRate)));
    const until = Math.max(skip, Math.min(audio.length, Math.floor((keepTo - start) * audio.sampleRate)));
    acc.add(channels, audio.sampleRate, start + skip / audio.sampleRate, skip, until - skip);
    report(chunk.fileOffset);
    await yieldToUi();
  }
  if (!decodedAny) return null;
  return { peaks: acc.toWaveSurferChannel(), pps: acc.pps, format };
}
