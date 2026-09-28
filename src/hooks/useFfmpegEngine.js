import { useCallback, useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { shouldPreloadEngine } from '../lib/device.js';
import { isFfmpegProgressLine, parseFfmpegProgressSeconds } from '../lib/progress.js';

// Peso esatto del wasm, iniettato a build time (vite.config.js): serve per una %
// corretta anche quando il server comprime la risposta (content-length ≠ bytes letti).
// eslint-disable-next-line no-undef
const ENGINE_WASM_BYTES = typeof __FFMPEG_WASM_BYTES__ === 'number' ? __FFMPEG_WASM_BYTES__ : 32 * 1024 * 1024;
const ENGINE_MIN_WASM_BYTES = 20 * 1024 * 1024;
const ENGINE_FETCH_MAX_ATTEMPTS = 3;
const ENGINE_STALL_TIMEOUT_MS = 20000;
// Download completato: compilare 32MB di wasm su un telefono lento richiede
// secondi, mai minuti. Oltre questa soglia il worker è morto (es. OOM silenzioso).
const ENGINE_LOAD_TIMEOUT_MS = 120000;
const ENGINE_CACHE_NAME = 'ffmpeg-wasm-v2';
const PROGRESS_THROTTLE_MS = 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteUrl(url) {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
}

/** Elimina le cache wasm potenzialmente avvelenate (tronche/opache). */
export async function purgeWasmCaches() {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.includes('ffmpeg-wasm'))
        .map((key) => caches.delete(key).catch(() => false)),
    );
  } catch {
    // Cache API non disponibile: niente da purgare
  }
}

/**
 * Wasm già in cache E servibile dal service worker che controlla la pagina:
 * in quel caso il load dagli URL statici è istantaneo, niente download.
 */
async function isWasmServedFromCache() {
  try {
    if (!globalThis.navigator?.serviceWorker?.controller || typeof caches === 'undefined') {
      return false;
    }
    const cached = await caches.match(absoluteUrl(ffmpegWasmUrl), { cacheName: ENGINE_CACHE_NAME })
      ?? await caches.match(absoluteUrl(ffmpegWasmUrl));
    if (!cached || !cached.ok) {
      return false;
    }
    const length = Number(cached.headers.get('content-length')) || 0;
    // Senza content-length (risposta in streaming) ci si fida: CacheFirst salva solo 200 pieni.
    return length === 0 || length >= ENGINE_MIN_WASM_BYTES;
  } catch {
    return false;
  }
}

/**
 * Download resiliente del wasm per reti mobili instabili, con progresso reale:
 * - resume via Range dopo uno stallo (niente ripartenza da 0 a 29/32MB)
 * - watchdog anti-stallo anche mentre read() pende (TCP morto)
 * - i byte finiscono in un Blob tipizzato application/wasm (il MIME è
 *   obbligatorio: senza tipo il browser rifiuta lo streaming/import).
 */
async function downloadEngineWasm({ onBytes }) {
  const chunks = [];
  let loaded = 0;
  let total = ENGINE_WASM_BYTES;
  for (let attempt = 1; attempt <= ENGINE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const headers = loaded > 0 ? { Range: `bytes=${loaded}-` } : {};
    let response;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await fetch(ffmpegWasmUrl, { headers });
    } catch (networkError) {
      if (attempt >= ENGINE_FETCH_MAX_ATTEMPTS) {
        throw new Error('Rete assente o instabile: non riesco a scaricare il motore di taglio.');
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000 * attempt);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Download motore non riuscito (HTTP ${response.status}).`);
    }
    if (response.status === 200 && loaded > 0) {
      // Server senza resume: si riparte da 0.
      chunks.length = 0;
      loaded = 0;
    }
    const encoding = String(response.headers.get('content-encoding') ?? '').toLowerCase();
    const length = Number(response.headers.get('content-length')) || 0;
    if (response.status === 200 && length > 0 && (!encoding || encoding === 'identity')) {
      total = length;
    }
    if (!response.body) {
      // Browser senza stream: niente % intermedia ma download comunque valido.
      // eslint-disable-next-line no-await-in-loop
      const blob = await response.blob();
      loaded = blob.size;
      chunks.length = 0;
      chunks.push(blob);
      onBytes(loaded, Math.max(total, loaded));
      break;
    }
    const reader = response.body.getReader();
    let stalled = false;
    try {
      for (;;) {
        let timer = null;
        // eslint-disable-next-line no-await-in-loop
        const result = await Promise.race([
          reader.read(),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ stalled: true }), ENGINE_STALL_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (result.stalled) {
          stalled = true;
          break;
        }
        if (result.done) {
          break;
        }
        if (result.value?.byteLength) {
          chunks.push(result.value);
          loaded += result.value.byteLength;
          onBytes(loaded, Math.max(total, loaded));
        }
      }
    } finally {
      if (stalled) {
        reader.cancel().catch(() => {});
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    if (!stalled) {
      break;
    }
    if (attempt >= ENGINE_FETCH_MAX_ATTEMPTS) {
      throw new Error('Connessione in stallo durante il download del motore. Riprova con una rete più stabile.');
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000 * attempt);
  }

  const blob = new Blob(chunks, { type: 'application/wasm' });
  chunks.length = 0;
  if (blob.size < ENGINE_MIN_WASM_BYTES) {
    throw new Error('Motore scaricato incompleto. Controlla la connessione e riprova.');
  }
  const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new Error('Motore scaricato corrotto. Premi "Pulisci cache e ricarica" in fondo alla pagina.');
  }
  return blob;
}

/** Salva il wasm scaricato nella cache del SW: dalla visita successiva è istantaneo. */
async function storeWasmInCache(blob) {
  try {
    if (!import.meta.env.PROD || typeof caches === 'undefined' || globalThis.navigator?.serviceWorker?.controller) {
      // Con il SW attivo la CacheFirst ha già salvato la risposta: niente doppia scrittura.
      return;
    }
    const cache = await caches.open(ENGINE_CACHE_NAME);
    await cache.put(
      absoluteUrl(ffmpegWasmUrl),
      new Response(blob, {
        headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(blob.size) },
      }),
    );
  } catch {
    // quota piena o cache non disponibile: la prossima visita riscaricherà
  }
}

function isCorruptEngineError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return /compileerror|failed to fetch dynamically|importscripts|networkerror|aborted|magic|wasm/.test(message);
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.isTimeout = true;
        reject(error);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const IDLE_ENGINE = { phase: 'idle', loaded: 0, total: 0, startedAt: 0, error: '' };

/**
 * Motore FFmpeg condiviso con stato osservabile:
 * engineInfo.phase = idle | downloading | compiling | ready | error,
 * con byte reali durante il download. Qualunque parte della UI (caricamento,
 * export, chip di stato) legge lo stesso stato: niente callback per chiamata
 * che si perdono quando il load è già partito in background.
 */
export function useFfmpegEngine() {
  const ffmpegRef = useRef(null);
  const loadPromiseRef = useRef(null);
  const [engineInfo, setEngineInfo] = useState(IDLE_ENGINE);
  const [technicalLog, setTechnicalLog] = useState('');
  const lastBytesReportRef = useRef(0);
  // Ogni resetAfterAbort invalida il load in corso: niente stato "ready"
  // pubblicato da un'istanza già terminata.
  const generationRef = useRef(0);

  const createInstance = useCallback(() => {
    const ffmpeg = new FFmpeg();
    // Throttle: durante esecuzioni lunghe arrivano decine di log al secondo
    // e ogni setState è un re-render. Le righe di -progress non sono log utili.
    let lastLogAt = 0;
    ffmpeg.on('log', ({ message }) => {
      const compact = String(message ?? '').trim();
      if (!compact || isFfmpegProgressLine(compact)) {
        return;
      }
      const now = Date.now();
      if (now - lastLogAt < 500) {
        return;
      }
      lastLogAt = now;
      setTechnicalLog(compact.slice(0, 240));
    });
    return ffmpeg;
  }, []);

  const ensureReady = useCallback(async () => {
    let ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      ffmpeg = createInstance();
      ffmpegRef.current = ffmpeg;
    }
    if (ffmpeg.loaded) {
      return ffmpeg;
    }
    if (!loadPromiseRef.current) {
      const instance = ffmpeg;
      const generation = generationRef.current;
      const assertCurrent = () => {
        if (generationRef.current !== generation) {
          throw new Error('Caricamento motore annullato.');
        }
      };
      const publish = (info) => {
        if (generationRef.current === generation) {
          setEngineInfo(info);
        }
      };
      loadPromiseRef.current = (async () => {
        const startedAt = Date.now();
        let wasmUrl = ffmpegWasmUrl;
        let blobUrl = '';
        if (await isWasmServedFromCache()) {
          publish({ phase: 'compiling', loaded: ENGINE_WASM_BYTES, total: ENGINE_WASM_BYTES, startedAt, error: '' });
        } else {
          publish({ phase: 'downloading', loaded: 0, total: ENGINE_WASM_BYTES, startedAt, error: '' });
          const blob = await downloadEngineWasm({
            onBytes: (loaded, total) => {
              const now = Date.now();
              if (now - lastBytesReportRef.current < PROGRESS_THROTTLE_MS && loaded < total) {
                return;
              }
              lastBytesReportRef.current = now;
              publish({ phase: 'downloading', loaded, total, startedAt, error: '' });
            },
          });
          storeWasmInCache(blob);
          assertCurrent();
          blobUrl = URL.createObjectURL(blob);
          wasmUrl = blobUrl;
          publish({ phase: 'compiling', loaded: blob.size, total: blob.size, startedAt, error: '' });
        }
        assertCurrent();
        try {
          await withTimeout(
            instance.load({ coreURL: ffmpegCoreUrl, wasmURL: wasmUrl }),
            ENGINE_LOAD_TIMEOUT_MS,
            'Il motore non risponde (memoria insufficiente?). Chiudi altre schede e riprova.',
          );
        } catch (loadError) {
          // Timeout = worker morto (OOM): un secondo tentativo costerebbe altri minuti.
          if (loadError?.isTimeout || (!isCorruptEngineError(loadError) && !blobUrl)) {
            throw loadError;
          }
          // Cache avvelenata o Blob rifiutato: purga e riprova UNA volta da rete/statico.
          await purgeWasmCaches();
          try {
            instance.terminate();
          } catch {
            // ignore
          }
          assertCurrent();
          const fresh = createInstance();
          ffmpegRef.current = fresh;
          await withTimeout(
            fresh.load({ coreURL: ffmpegCoreUrl, wasmURL: ffmpegWasmUrl }),
            ENGINE_LOAD_TIMEOUT_MS,
            'Il motore non risponde (memoria insufficiente?). Chiudi altre schede e riprova.',
          );
        } finally {
          // Compilato: il Blob da 32MB non serve più (dopo un terminate si
          // ricarica dagli URL statici, serviti dalla cache del SW).
          if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
          }
        }
        assertCurrent();
        publish({ phase: 'ready', loaded: 0, total: 0, startedAt, error: '' });
      })().catch((error) => {
        if (generationRef.current === generation) {
          setEngineInfo({ ...IDLE_ENGINE, phase: 'error', error: error?.message || 'Motore non disponibile.' });
          try {
            ffmpegRef.current?.terminate();
          } catch {
            // ignore
          }
          ffmpegRef.current = null;
        } else {
          try {
            instance.terminate();
          } catch {
            // ignore
          }
        }
        throw error;
      });
      const pending = loadPromiseRef.current;
      pending.catch(() => {}).finally(() => {
        if (loadPromiseRef.current === pending) {
          loadPromiseRef.current = null;
        }
      });
    }
    await loadPromiseRef.current;
    const ready = ffmpegRef.current;
    if (!ready?.loaded) {
      throw new Error('Motore non disponibile. Riprova.');
    }
    return ready;
  }, [createInstance]);

  useEffect(() => {
    // Niente preload del wasm (32MB + compilazione) al boot su mobile / save-data:
    // su quei dispositivi parte dopo il caricamento del file (vedi App).
    if (!shouldPreloadEngine()) {
      return undefined;
    }
    let cancelled = false;
    const preload = () => {
      if (!cancelled) {
        ensureReady().catch(() => {});
      }
    };
    let idleHandle = null;
    let timeoutHandle = null;
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(preload, { timeout: 2500 });
    } else {
      timeoutHandle = window.setTimeout(preload, 400);
    }
    return () => {
      cancelled = true;
      if (idleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
    };
  }, [ensureReady]);

  useEffect(() => {
    return () => {
      try {
        ffmpegRef.current?.terminate();
      } catch {
        // ignore
      }
      ffmpegRef.current = null;
    };
  }, []);

  const resetAfterAbort = useCallback(() => {
    // Terminate interrompe un exec in corso; il prossimo ensureReady ricrea il motore.
    generationRef.current += 1;
    try {
      ffmpegRef.current?.terminate();
    } catch {
      // ignore
    }
    ffmpegRef.current = null;
    loadPromiseRef.current = null;
    setEngineInfo(IDLE_ENGINE);
  }, []);

  return {
    ffmpegRef,
    engineInfo,
    technicalLog,
    setTechnicalLog,
    ensureReady,
    resetAfterAbort,
  };
}

/**
 * Esegue ffmpeg con avanzamento REALE: `-progress pipe:1` scrive righe
 * terminate da \n ogni ~0,5s (le stats su stderr no: finiscono con \r e il
 * buffer TTY di Emscripten le rilascia solo a fine job).
 * onProgress(frac, seconds) riceve i secondi di OUTPUT già scritti.
 */
export async function runFfmpeg(ffmpeg, args, { durationSeconds = 0, onProgress = null, captureLog = false } = {}) {
  const logs = [];
  const tail = [];
  let lastSeconds = -1;
  const report = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds <= lastSeconds) {
      return;
    }
    lastSeconds = seconds;
    if (typeof onProgress === 'function') {
      const frac = durationSeconds > 0 ? Math.min(1, seconds / durationSeconds) : null;
      try {
        onProgress(frac, seconds);
      } catch {
        // il reporting non deve mai rompere l'esecuzione
      }
    }
  };
  const onLog = ({ message }) => {
    if (typeof message !== 'string') {
      return;
    }
    const seconds = parseFfmpegProgressSeconds(message);
    if (seconds !== null) {
      report(seconds);
      return;
    }
    if (isFfmpegProgressLine(message)) {
      return;
    }
    if (captureLog) {
      logs.push(message);
    }
    tail.push(message);
    if (tail.length > 30) {
      tail.shift();
    }
  };
  const onProgressEvent = ({ time }) => {
    const micros = Number(time);
    if (Number.isFinite(micros) && micros >= 0) {
      report(micros / 1e6);
    }
  };
  const fullArgs = args.includes('-progress') ? [...args] : ['-progress', 'pipe:1', ...args];
  if (!fullArgs.includes('-nostats')) {
    fullArgs.unshift('-nostats');
  }
  // Il livello di log è globale nel modulo wasm: un `ffprobe -v error`
  // precedente lo lascia a "error" e sparirebbero i log info (silencedetect,
  // Duration/Stream di `ffmpeg -i`). Va reimpostato a ogni esecuzione.
  if (!fullArgs.includes('-loglevel') && !fullArgs.includes('-v')) {
    fullArgs.unshift('-loglevel', 'info');
  }
  ffmpeg.on('log', onLog);
  ffmpeg.on('progress', onProgressEvent);
  try {
    const exitCode = await ffmpeg.exec(fullArgs);
    return { exitCode, logText: logs.join('\n'), tailText: tail.join('\n') };
  } finally {
    ffmpeg.off('log', onLog);
    ffmpeg.off('progress', onProgressEvent);
  }
}

export async function safeDelete(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    return false;
  }
  return true;
}
