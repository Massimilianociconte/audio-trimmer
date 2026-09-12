/**
 * Architettura export anti-OOM.
 *
 * Principio: mai tenere in RAM più di UN segmento alla volta.
 * - "folder": ogni parte è scritta subito su disco via File System Access
 *   (showDirectoryPicker). Picco RAM ≈ 1 segmento. Riprendibile dopo reload.
 * - "zip-stream": ZIP scritto in streaming su file via showSaveFilePicker +
 *   @zip.js/zip.js (ZipWriter su WritableStream). Picco RAM ≈ 1 segmento.
 * - "zip-classic": ZIP in memoria via BlobWriter (Blob, spillabile su disco
 *   dal browser). Picco ≈ ZIP compresso + 1 segmento. Fallback universale.
 * - "singles": download sequenziali senza ZIP; i Blob vengono trattenuti per
 *   il re-download solo sotto soglia, altrimenti solo metadati.
 */

export const EXPORT_DESTINATIONS = {
  auto: { id: 'auto', label: 'Automatica (consigliata)' },
  folder: { id: 'folder', label: 'Cartella (streaming su disco)' },
  'zip-stream': { id: 'zip-stream', label: 'File ZIP (streaming su disco)' },
  'zip-classic': { id: 'zip-classic', label: 'ZIP in memoria (compatibile)' },
  singles: { id: 'singles', label: 'File singoli (senza ZIP)' },
};

export const EXPORT_DESTINATION_ORDER = ['auto', 'folder', 'zip-stream', 'zip-classic', 'singles'];

// Soglie (byte) per l'advisor. Conservative: MEMFS FFmpeg tiene già l'intero
// input in RAM, quindi il budget per l'output deve restare stretto.
export const HEAVY_INPUT_BYTES = 350 * 1024 * 1024;
export const HEAVY_OUTPUT_BYTES = 250 * 1024 * 1024;
export const RETAIN_BLOBS_BYTES = 150 * 1024 * 1024;
export const MANY_SEGMENTS = 24;

export const CHECKPOINT_KEY = 'ac-export-checkpoint';

export function getExportCapabilities(env = globalThis) {
  const hasFS = (obj, method) => Boolean(obj && typeof obj[method] === 'function');
  return {
    directoryPicker: hasFS(env?.showDirectoryPicker, 'call') || typeof env?.showDirectoryPicker === 'function',
    filePicker: typeof env?.showSaveFilePicker === 'function',
    wakeLock: Boolean(env?.navigator?.wakeLock?.request),
    webStreams: typeof env?.WritableStream === 'function',
  };
}

/**
 * Pura e testabile: sceglie la strategia di scrittura.
 * Ritorna { mode, reasons[], warnings[] }.
 */
export function adviseExportStrategy({
  fileSizeBytes = 0,
  totalEstimateBytes = 0,
  segmentCount = 0,
  capabilities = {},
  preference = 'auto',
} = {}) {
  const reasons = [];
  const warnings = [];
  const caps = {
    directoryPicker: false,
    filePicker: false,
    ...capabilities,
  };

  const heavy = fileSizeBytes > HEAVY_INPUT_BYTES
    || totalEstimateBytes > HEAVY_OUTPUT_BYTES
    || segmentCount > MANY_SEGMENTS;
  if (heavy) {
    reasons.push('Progetto pesante: uso scrittura incrementale (un segmento alla volta in RAM).');
  }

  const pick = (mode) => ({ mode, reasons, warnings });

  if (preference && preference !== 'auto') {
    if (preference === 'folder' && !caps.directoryPicker) {
      warnings.push('Scrittura su cartella non supportata da questo browser: ripiego su ZIP in streaming.');
    } else if (preference === 'zip-stream' && !caps.filePicker) {
      warnings.push('Salvataggio file diretto non supportato: ripiego su ZIP in memoria.');
    } else {
      reasons.push(`Destinazione scelta manualmente: ${preference}.`);
      return pick(preference);
    }
  }

  if (caps.directoryPicker && (heavy || segmentCount > 8)) {
    reasons.push('Cartella su disco: zero accumulo in RAM e ripresa possibile dopo interruzione.');
    return pick('folder');
  }
  if (caps.filePicker) {
    reasons.push('ZIP scritto direttamente su disco man mano che le parti sono pronte.');
    return pick('zip-stream');
  }
  if (totalEstimateBytes <= RETAIN_BLOBS_BYTES) {
    reasons.push('Output contenuto: ZIP in memoria con re-download dei singoli.');
    return pick('zip-classic');
  }
  warnings.push(
    'Browser senza salvataggio diretto e output grande: scarico i singoli in sequenza senza trattenerli in memoria (il re-download non sarà disponibile).',
  );
  return pick('singles');
}

/** Piccola cessione del thread per far respirare UI/GC tra un segmento e l'altro. */
export function yieldToUI() {
  return new Promise((resolve) => {
    if (typeof globalThis.requestIdleCallback === 'function') {
      globalThis.requestIdleCallback(() => resolve(), { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export function writeCheckpoint(job) {
  try {
    globalThis.localStorage?.setItem(CHECKPOINT_KEY, JSON.stringify({ ...job, savedAt: Date.now() }));
  } catch {
    // storage non disponibile: checkpoint solo in memoria di sessione
  }
}

export function readCheckpoint() {
  try {
    const raw = globalThis.localStorage?.getItem(CHECKPOINT_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearCheckpoint() {
  try {
    globalThis.localStorage?.removeItem(CHECKPOINT_KEY);
  } catch {
    // ignore
  }
}

/** Scrive un Blob su un FileSystemFileHandle con abort pulito in caso di errore. */
export async function writeBlobToFileHandle(fileHandle, blob) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // ignore
    }
    throw error;
  }
}

function sanitizeEntryName(name) {
  return String(name ?? 'parte').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120) || 'parte';
}

/**
 * Crea uno ZipWriter di @zip.js/zip.js sopra un WritableStream
 * (es. da showSaveFilePicker().createWritable()).
 * Ritorna { add(name, uint8Data), close() }.
 * L'audio è già compresso: usa STORE (level 0) con fallback a default.
 */
export async function createZipStreamWriter(writable) {
  const { ZipWriter, Uint8ArrayReader } = await import('@zip.js/zip.js');
  const writer = new ZipWriter(writable);
  let storeOk = true;
  let settled = false;
  return {
    async add(name, uint8Data) {
      const entryName = sanitizeEntryName(name);
      if (storeOk) {
        try {
          await writer.add(entryName, new Uint8ArrayReader(uint8Data), { level: 0 });
          return;
        } catch {
          storeOk = false;
        }
      }
      await writer.add(entryName, new Uint8ArrayReader(uint8Data));
    },
    async close() {
      if (settled) {
        return;
      }
      settled = true;
      return writer.close();
    },
    async abort() {
      if (settled) {
        return;
      }
      settled = true;
      try {
        await writable.abort();
      } catch {
        // ignore
      }
    },
  };
}

/** ZipWriter in memoria (Blob finale). Picco ≈ ZIP compresso, spillabile dal browser. */
export async function createZipBlobWriter() {
  const { ZipWriter, BlobWriter, Uint8ArrayReader } = await import('@zip.js/zip.js');
  const blobWriter = new BlobWriter('application/zip');
  const writer = new ZipWriter(blobWriter);
  let storeOk = true;
  let settled = false;
  return {
    async add(name, uint8Data) {
      const entryName = sanitizeEntryName(name);
      if (storeOk) {
        try {
          await writer.add(entryName, new Uint8ArrayReader(uint8Data), { level: 0 });
          return;
        } catch {
          storeOk = false;
        }
      }
      await writer.add(entryName, new Uint8ArrayReader(uint8Data));
    },
    async close() {
      if (settled) {
        return null;
      }
      settled = true;
      await writer.close();
      return blobWriter.getData();
    },
    async abort() {
      settled = true;
    },
  };
}
