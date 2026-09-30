import { isMobileDevice, isLowMemoryDevice } from './device.js';

const MiB = 1024 * 1024;

// Budgets concern additional output allocations, not available physical RAM.
// MEMFS grows geometrically; readFile copies the file before transferring it.
export function outputMemoryPolicy(env = globalThis) {
  if (isMobileDevice(env)) {
    return { segmentBytes: 32 * MiB, archiveBytes: 64 * MiB, retainBytes: 16 * MiB };
  }
  if (isLowMemoryDevice(env)) {
    return { segmentBytes: 64 * MiB, archiveBytes: 128 * MiB, retainBytes: 32 * MiB };
  }
  return { segmentBytes: 192 * MiB, archiveBytes: 256 * MiB, retainBytes: 150 * MiB };
}

export function assertOutputBudget(bytes, env = globalThis) {
  const limit = outputMemoryPolicy(env).segmentBytes;
  // Leave room for container headers, variable bitrate and size estimation error.
  if (!Number.isFinite(bytes) || bytes * 1.15 > limit) {
    throw new Error(`Risultato troppo grande per elaborarlo in sicurezza (limite per parte ~${limit / MiB} MB). Aumenta il numero di parti, accorcia la selezione o converti in M4A/MP3 a bitrate più basso.`);
  }
  return limit;
}

export async function mountAudioInput(ffmpeg, source, sequence, env = globalThis) {
  const blob = source?.blob;
  if (!blob) throw new Error('Audio non più disponibile: ricarica il file.');
  const extension = String(source.extension || '.audio').replace(/[^.a-z0-9]/gi, '') || '.audio';
  const name = `input${extension}`;
  const dir = `/in${sequence}`;
  try {
    await ffmpeg.createDir(dir);
    const mounted = await ffmpeg.mount('WORKERFS', { blobs: [{ name, data: blob }] }, dir);
    if (mounted === false) throw new Error('WORKERFS non disponibile');
    return { ffmpeg, blob, dir, path: `${dir}/${name}`, memfs: false };
  } catch (error) {
    try { await ffmpeg.deleteDir(dir); } catch { /* best effort */ }
    if (ffmpeg.loaded === false) throw error;
    // The compatibility fallback must never turn a large File into a full buffer.
    const fallbackLimit = isMobileDevice(env) || isLowMemoryDevice(env) ? 8 * MiB : 32 * MiB;
    if (blob.size > fallbackLimit) {
      throw new Error('Questo motore non supporta WORKERFS: la copia integrale del file supererebbe il budget di memoria. Riprova il motore o usa un file più piccolo.');
    }
    const path = `/input-${sequence}${extension}`;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (ffmpeg.loaded === false) throw error;
      await ffmpeg.writeFile(path, bytes);
      return { ffmpeg, blob, dir: '', path, memfs: true };
    } catch (writeError) {
      try { await ffmpeg.deleteFile(path); } catch { /* best effort */ }
      throw writeError;
    }
  }
}

export async function readAudioOutput(ffmpeg, path, limit = outputMemoryPolicy().segmentBytes) {
  try {
    const bytes = await ffmpeg.readFile(path);
    // -fs can exit successfully after truncating the file. Never offer it as success.
    if (bytes.byteLength >= limit) {
      throw new Error('Il risultato ha raggiunto il limite di memoria per parte. Aumenta il numero di parti o usa M4A/MP3 a bitrate più basso.');
    }
    return bytes;
  } finally {
    try { await ffmpeg.deleteFile(path); } catch { /* terminated worker */ }
  }
}
