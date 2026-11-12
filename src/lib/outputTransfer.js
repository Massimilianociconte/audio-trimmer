/**
 * Uscite del motore con meno copie in memoria (solo telefoni/tablet).
 *
 * Senza questo modulo, una parte scritta da FFmpeg in MEMFS:
 * - cresce del 12,5% per volta: decine di riallocazioni, ognuna copia tutto
 *   il contenuto già scritto (≈ 8× la dimensione finale di memcpy) e per un
 *   attimo tiene vecchio + nuovo buffer;
 * - viene poi letta con FS.readFile, che ne fa una copia intera mentre il
 *   file virtuale è ancora vivo (picco ≈ 2,1× la parte).
 *
 * Qui, nel worker:
 * - una «dimensione prevista» (hint) preassegna il buffer una volta sola;
 * - la lettura «take» consegna il buffer del file al main thread per
 *   trasferimento (zero copie) e rimuove il file virtuale.
 *
 * Misurato su Chromium e WebKit con lo stesso core: uscite identiche byte per
 * byte. Nel flusso reale (taglio senza ricodifica, tablet emulati): Galaxy Tab
 * −14% di tempo e −12% di picco, iPad −14% di picco (PERFORMANCE-AUDIT.md).
 * Ogni passo ha un ripiego sul comportamento originale.
 */

export const OUTPUT_HINT_DIR = '/.ac-output-hint/';
export const TAKE_ENCODING = 'ac-take';
export const PING_TYPE = 'AC_PING';
export const PONG_TYPE = 'AC_PONG';

// Sotto 1 MiB la crescita standard costa poco; sopra 1 GiB è certamente un
// errore (i budget per parte arrivano a 512 MiB): mai preassegnare.
const MIN_HINT_BYTES = 1024 * 1024;
const MAX_HINT_BYTES = 1024 * 1024 * 1024;
// Oltre questo spreco (capacità − byte scritti) si consegna una copia esatta:
// una vista trasferita terrebbe vivo anche lo spazio inutilizzato.
const MAX_VIEW_WASTE_RATIO = 1 / 8;

function basename(path) {
  const text = String(path ?? '');
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

export function outputHintPath(outputName) {
  return `${OUTPUT_HINT_DIR}${basename(outputName)}`;
}

/** Byte validi per una preassegnazione, altrimenti 0. */
export function sanitizeHintBytes(bytes) {
  const value = Math.ceil(Number(bytes));
  if (!Number.isFinite(value) || value < MIN_HINT_BYTES || value > MAX_HINT_BYTES) {
    return 0;
  }
  return value;
}

/**
 * Sostituisce MEMFS.expandFileStorage: per i file con un hint la prima
 * crescita alloca subito la dimensione prevista. Senza hint (o se il file
 * supera la previsione) resta la crescita originale di Emscripten.
 */
export function installOutputPatches(core, hints) {
  const MEMFS = core?.FS?.filesystems?.MEMFS;
  if (!MEMFS || typeof MEMFS.expandFileStorage !== 'function' || !(hints instanceof Map)) {
    return false;
  }
  if (MEMFS.acOutputPatched) {
    return true;
  }
  const originalExpand = MEMFS.expandFileStorage;
  MEMFS.expandFileStorage = function expandWithHint(node, newCapacity) {
    const contents = node?.contents ?? null;
    const previous = contents ? contents.length : 0;
    const hint = node ? hints.get(node.name) : 0;
    const typed = contents === null || ArrayBuffer.isView(contents);
    if (hint && typed && previous < newCapacity && newCapacity <= hint && previous < hint) {
      const next = new Uint8Array(hint);
      const used = Number(node.usedBytes) || 0;
      if (contents && used > 0) {
        next.set(contents.subarray(0, used), 0);
      }
      node.contents = next;
      return undefined;
    }
    return originalExpand.call(this, node, newCapacity);
  };
  MEMFS.acOutputPatched = true;
  return true;
}

/** Interpreta una scrittura di controllo `/.ac-output-hint/<nome>`. */
export function parseHintWrite(data) {
  const path = data?.path;
  if (typeof path !== 'string' || !path.startsWith(OUTPUT_HINT_DIR)) {
    return null;
  }
  const name = path.slice(OUTPUT_HINT_DIR.length);
  if (!name || name.includes('/')) {
    return { name: '', bytes: 0 };
  }
  let text = '';
  try {
    const payload = data.data;
    text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  } catch {
    text = '';
  }
  return { name, bytes: sanitizeHintBytes(text) };
}

/**
 * Prepara i byte del file per il trasferimento: vista sul buffer MEMFS se
 * lo spazio inutilizzato è poco, altrimenti una copia esatta. Mai il buffer
 * della memoria wasm (trasferirlo distruggerebbe il motore).
 */
export function prepareTakeBytes(contents, usedBytes, heapBuffer = null) {
  const used = Math.max(0, Number(usedBytes) || 0);
  if (!contents || used === 0) {
    return new Uint8Array(0);
  }
  if (!ArrayBuffer.isView(contents)) {
    return Uint8Array.from(Array.prototype.slice.call(contents, 0, used));
  }
  const buffer = contents.buffer;
  const transferable = buffer instanceof ArrayBuffer
    && buffer !== heapBuffer
    && contents.byteOffset === 0
    && contents.length >= used
    && contents.length - used <= Math.max(MIN_HINT_BYTES, used * MAX_VIEW_WASTE_RATIO);
  if (!transferable) {
    return contents.slice(0, used);
  }
  return contents.length === used ? contents : contents.subarray(0, used);
}

/**
 * Gestisce i messaggi estesi nel worker. Ritorna true se il messaggio è
 * stato servito qui; false = va al gestore originale di @ffmpeg/ffmpeg.
 * Gli errori diventano un messaggio ERROR (il main thread ripiega).
 */
export function handleOutputMessage(message, { core, hints, post }) {
  const { id, type, data } = message ?? {};
  if (type === PING_TYPE) {
    post({ id, type: PONG_TYPE, data: true });
    return true;
  }
  if (!core?.FS || !(hints instanceof Map)) {
    return false;
  }
  if (type === 'WRITE_FILE') {
    const hint = parseHintWrite(data);
    if (!hint) return false;
    if (hint.name && hint.bytes) hints.set(hint.name, hint.bytes);
    else if (hint.name) hints.delete(hint.name);
    post({ id, type, data: true });
    return true;
  }
  if (type === 'READ_FILE' && data?.encoding === TAKE_ENCODING) {
    try {
      const { node } = core.FS.lookupPath(data.path);
      const bytes = prepareTakeBytes(node.contents, node.usedBytes, core.HEAPU8?.buffer ?? null);
      const transfer = bytes.byteLength > 0 ? [bytes.buffer] : [];
      // Prima la consegna: se il trasferimento fallisse il file resterebbe
      // al suo posto e il main thread lo rileggerebbe nel modo classico.
      post({ id, type, data: bytes }, transfer);
      hints.delete(node.name);
      try {
        core.FS.unlink(data.path);
      } catch {
        // già rimosso: niente da liberare
      }
    } catch (error) {
      post({ id, type: 'ERROR', data: String(error?.message ?? error) });
    }
    return true;
  }
  return false;
}
