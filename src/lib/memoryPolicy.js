import { deviceMemoryGB } from './device.js';

const MiB = 1024 * 1024;
// Margine per header del container, bitrate variabile ed errore di stima.
const OUTPUT_MARGIN = 1.15;

/**
 * Requisito di prodotto: su QUALUNQUE dispositivo (telefono, tablet, desktop)
 * una parte da 100 MB deve passare. Una registrazione da 160–180 MB divisa
 * in due deve esportarsi ovunque.
 */
export const MIN_PART_BYTES = 160 * MiB;

/**
 * Budget delle allocazioni di output (non RAM libera). Picco reale di una
 * parte ≈ 2,1× la sua dimensione: MEMFS cresce del 12,5% per volta
 * (vecchio + nuovo buffer durante la crescita) e readFile ne fa una copia.
 * Parte da 160 MiB → ~340 MiB transitori; 256 → ~540; 512 → ~1,1 GiB.
 *
 * Conta SOLO la memoria dichiarata dal browser (navigator.deviceMemory,
 * arrotondata per difetto: 3 GB → 2), mai il tipo di dispositivo: un tablet
 * e un PC con la stessa RAM hanno gli stessi limiti. Senza dato dichiarato
 * (Safari iPhone/iPad, Firefox) vale il profilo intermedio.
 */
export function outputMemoryPolicy(env = globalThis) {
  const declared = deviceMemoryGB(env);
  if (declared <= 2) {
    return { segmentBytes: MIN_PART_BYTES, archiveBytes: 256 * MiB, retainBytes: 256 * MiB };
  }
  if (declared >= 8) {
    return { segmentBytes: 512 * MiB, archiveBytes: 1024 * MiB, retainBytes: 512 * MiB };
  }
  // 4–7 GB dichiarati o dato assente. ZIP in memoria (iPhone/iPad): WebKit
  // può tenerne due copie durante Response.blob(), da cui il tetto a 384 MiB.
  return { segmentBytes: 256 * MiB, archiveBytes: 384 * MiB, retainBytes: 256 * MiB };
}

function formatMb(bytes) {
  return Math.max(1, Math.round(bytes / MiB));
}

/**
 * Rifiuta PRIMA della codifica una parte che supererebbe il budget.
 * Con `totalBytes` suggerisce quante parti servono su questo dispositivo.
 */
export function assertOutputBudget(bytes, env = globalThis, { totalBytes = 0, partCount = 0 } = {}) {
  const limit = outputMemoryPolicy(env).segmentBytes;
  if (!Number.isFinite(bytes) || bytes * OUTPUT_MARGIN > limit) {
    const minParts = Number.isFinite(totalBytes) && totalBytes > 0
      ? Math.ceil((totalBytes * OUTPUT_MARGIN) / limit)
      : 0;
    const size = Number.isFinite(bytes) ? `~${formatMb(bytes)} MB` : 'di dimensione sconosciuta';
    const maxPart = formatMb(limit / OUTPUT_MARGIN);
    // Parti già sufficienti ma sbilanciate: il rimedio è spostare i tagli.
    const advice = minParts > 1 && partCount >= minParts
      ? `Sposta i tagli in modo che nessuna parte superi ~${maxPart} MB`
      : minParts > 1
        ? `Dividi in almeno ${minParts} parti`
        : 'Aumenta il numero di parti';
    throw new Error(
      `Parte troppo grande (${size}): su questo dispositivo il limite per parte è ~${formatMb(limit)} MB. `
      + `${advice}, oppure converti in M4A/MP3 a bitrate più basso.`,
    );
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
    // Stesso picco di una parte (copia in main + MEMFS): stesso budget.
    const fallbackLimit = outputMemoryPolicy(env).segmentBytes;
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
