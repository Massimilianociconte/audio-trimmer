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

// Soglie (byte) per l'advisor. WORKERFS evita la copia dell'input;
// MEMFS conserva comunque l'intero segmento di output fino alla lettura.
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

/** Scrive su un FileSystemFileHandle. Accetta Blob o Uint8Array (niente Blob intermedio). */
export async function writeBlobToFileHandle(fileHandle, data, { signal } = {}) {
  signal?.throwIfAborted();
  const writable = await fileHandle.createWritable();
  const sink = writable.getWriter?.() ?? writable;
  let aborted = false;
  let completed = false;
  let rejectAbort;
  const cancellation = new Promise((_, reject) => { rejectAbort = reject; });
  cancellation.catch(() => {});
  const cancel = (reason = signal?.reason) => {
    if (aborted) return;
    aborted = true;
    rejectAbort(reason ?? new DOMException('Scrittura annullata', 'AbortError'));
    Promise.resolve(sink.abort(reason)).catch(() => {}).finally(() => sink.releaseLock?.());
  };
  const onAbort = () => cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    await Promise.race([sink.write(data), cancellation]);
    signal?.throwIfAborted();
    await Promise.race([sink.close(), cancellation]);
    signal?.throwIfAborted();
    completed = true;
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (completed) sink.releaseLock?.();
  }
}

function sanitizeEntryName(name) {
  return String(name ?? 'parte').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 120) || 'parte';
}

/**
 * Crea uno ZipWriter di @zip.js/zip.js sopra un WritableStream
 * (es. da showSaveFilePicker().createWritable()).
 * Ritorna { add(name, uint8Data), close() }.
 * L'audio è già compresso: usa STORE (level 0), nessun retry dopo errori.
 */
export async function createZipStreamWriter(writable, { signal } = {}) {
  const { ZipWriter, Uint8ArrayReader } = await import('@zip.js/zip.js');
  const controller = new AbortController();
  const sink = writable.getWriter();
  let settled = false;
  let released = false;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const release = () => {
    if (!released) { released = true; sink.releaseLock(); }
  };
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectAbort(controller.signal.reason);
    // An owned writer can be aborted while zip.js holds its relay stream lock.
    // Native writes may finish asynchronously; do not commit after cancellation.
    sink.abort(controller.signal.reason).catch(() => {}).finally(release);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const relay = new WritableStream({
    write(data) {
      controller.signal.throwIfAborted();
      return Promise.race([sink.write(data), aborted]);
    },
  });
  const writer = new ZipWriter(relay, { level: 0, bufferedWrite: false, signal: controller.signal });
  const detach = () => signal?.removeEventListener('abort', cancel);
  return {
    async add(name, uint8Data) {
      controller.signal.throwIfAborted();
      await writer.add(sanitizeEntryName(name), new Uint8ArrayReader(uint8Data));
      controller.signal.throwIfAborted();
    },
    async close() {
      if (settled) return;
      controller.signal.throwIfAborted();
      try {
        await writer.close();
        controller.signal.throwIfAborted();
        // zip.js closes only its relay. Commit the destination after its final
        // directory was written successfully and cancellation was checked.
        await Promise.race([sink.close(), aborted]);
        controller.signal.throwIfAborted();
        settled = true;
        release();
      } finally { detach(); }
    },
    async abort() {
      if (settled) return;
      settled = true;
      cancel();
      detach();
    },
  };
}

/** Compatible ZIP output. Only use within the device's total archive budget. */
export async function createZipBlobWriter(options = {}) {
  const { BlobWriter } = await import('@zip.js/zip.js');
  const blobWriter = new BlobWriter('application/zip');
  const writer = await createZipStreamWriter(blobWriter.writable, options);
  return {
    add: writer.add,
    abort: writer.abort,
    async close() {
      await writer.close();
      return blobWriter.getData();
    },
  };
}
