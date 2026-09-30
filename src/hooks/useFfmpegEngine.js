import { useCallback, useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { shouldPreloadEngine } from '../lib/device.js';
import { isFfmpegProgressLine } from '../lib/progress.js';
import { downloadEngineWasm } from '../lib/engineDownload.js';
import { withActiveTimeout } from '../lib/activityWatch.js';

// Peso esatto del wasm, iniettato a build time (vite.config.js): serve per una %
// corretta anche quando il server comprime la risposta (content-length ≠ bytes letti).
// eslint-disable-next-line no-undef
const ENGINE_WASM_BYTES = typeof __FFMPEG_WASM_BYTES__ === 'number' ? __FFMPEG_WASM_BYTES__ : 32 * 1024 * 1024;
// Download completato: compilare 32MB di wasm su un telefono lento richiede
// secondi, mai minuti. Oltre questa soglia il worker è morto (es. OOM silenzioso).
const ENGINE_LOAD_TIMEOUT_MS = 120000;
const ENGINE_CACHE_NAME = 'audio-cutter-ffmpeg-wasm-v3';
const PROGRESS_THROTTLE_MS = 120;

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

/** Risposta valida del wasm nella Cache Storage, con o senza service worker attivo. */
async function findCachedWasm() {
  try {
    if (typeof caches === 'undefined') {
      return null;
    }
    const cached = await caches.match(absoluteUrl(ffmpegWasmUrl), { cacheName: ENGINE_CACHE_NAME })
      ?? await caches.match(absoluteUrl(ffmpegWasmUrl));
    if (!cached || !cached.ok) {
      return null;
    }
    const length = Number(cached.headers.get('content-length')) || 0;
    const encoding = cached.headers.get('content-encoding');
    // Senza content-length (risposta in streaming) ci si fida: CacheFirst salva solo 200 pieni.
    const valid = length === 0 || Boolean(encoding && encoding !== 'identity') || length === ENGINE_WASM_BYTES;
    return valid ? cached : null;
  } catch {
    return null;
  }
}

/**
 * Wasm già in cache E servibile dal service worker che controlla la pagina:
 * in quel caso il load dagli URL statici è istantaneo, niente download.
 */
async function isWasmServedFromCache() {
  if (!globalThis.navigator?.serviceWorker?.controller) {
    return false;
  }
  return Boolean(await findCachedWasm());
}

/**
 * Wasm in cache ma pagina non ancora controllata dal SW (prima visita,
 * aggiornamento in attesa): lo si legge dalla cache invece di riscaricarlo.
 */
async function readCachedWasmBlob() {
  try {
    const cached = await findCachedWasm();
    if (!cached) {
      return null;
    }
    const blob = await cached.blob();
    const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (blob.size < 1024 * 1024 || magic[0] !== 0 || magic[1] !== 97 || magic[2] !== 115 || magic[3] !== 109) {
      return null;
    }
    return new Blob([blob], { type: 'application/wasm' });
  } catch {
    return null;
  }
}

/** Salva il wasm scaricato nella cache del SW: dalla visita successiva è istantaneo. */
async function storeWasmInCache(blob, { force = false } = {}) {
  try {
    if (!import.meta.env.PROD || typeof caches === 'undefined') {
      return;
    }
    if (!force && globalThis.navigator?.serviceWorker?.controller) {
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

// Scadenza in tempo ATTIVO: compilare mentre l'utente è in un'altra app
// (iPad, telefono) non deve far fallire l'avvio del motore al ritorno.
function withTimeout(promise, ms, message) {
  return withActiveTimeout(promise, ms, message);
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
  const downloadAbortRef = useRef(null);
  // Download anticipato senza compilazione (mobile/PC deboli): nessun worker
  // né heap wasm residente, solo byte in Cache Storage.
  const prefetchRef = useRef(null);
  const prefetchAbortRef = useRef(null);
  const cachedRef = useRef(false);

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
      const downloadAbort = new AbortController();
      downloadAbortRef.current = downloadAbort;
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
        // Download anticipato in corso (mobile): lo si aspetta invece di
        // raddoppiarlo. La barra continua a mostrare i suoi byte reali.
        if (prefetchRef.current) {
          await prefetchRef.current.catch(() => {});
          assertCurrent();
        }
        const startedAt = Date.now();
        let wasmUrl = ffmpegWasmUrl;
        let blobUrl = '';
        if (await isWasmServedFromCache()) {
          publish({ phase: 'compiling', loaded: ENGINE_WASM_BYTES, total: ENGINE_WASM_BYTES, startedAt, error: '' });
        } else {
          let blob = await readCachedWasmBlob();
          if (!blob) {
            publish({ phase: 'downloading', loaded: 0, total: ENGINE_WASM_BYTES, startedAt, error: '' });
            blob = await downloadEngineWasm(ffmpegWasmUrl, {
              expectedBytes: ENGINE_WASM_BYTES,
              signal: downloadAbort.signal,
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
          }
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
          cachedRef.current = false;
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
        if (import.meta.env.PROD) {
          cachedRef.current = true;
        }
        publish({ phase: 'ready', loaded: 0, total: 0, startedAt, error: '' });
      })().catch(async (error) => {
        if (generationRef.current === generation && /incompleto|corrotto|dimensione/i.test(String(error?.message ?? error))) {
          await purgeWasmCaches();
          cachedRef.current = false;
        }
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
        if (downloadAbortRef.current === downloadAbort) downloadAbortRef.current = null;
        if (loadPromiseRef.current === pending) {
          loadPromiseRef.current = null;
        }
      });
    }
    const currentGeneration = generationRef.current;
    await loadPromiseRef.current;
    if (currentGeneration !== generationRef.current) throw new Error('Caricamento motore annullato.');
    const ready = ffmpegRef.current;
    if (!ready?.loaded) {
      throw new Error('Motore non disponibile. Riprova.');
    }
    return ready;
  }, [createInstance]);

  /**
   * Scarica il wasm nella Cache Storage SENZA compilarlo. Su mobile toglie
   * dall'export la parte lenta (rete), senza il costo residente di worker e
   * heap: la compilazione resta al primo uso. Solo in produzione (in dev non
   * c'è una cache da cui rileggerlo).
   */
  const prefetchEngine = useCallback(() => {
    if (prefetchRef.current) {
      return prefetchRef.current;
    }
    if (!import.meta.env.PROD || cachedRef.current || loadPromiseRef.current || ffmpegRef.current?.loaded) {
      return Promise.resolve();
    }
    const abort = new AbortController();
    prefetchAbortRef.current = abort;
    // Mai sovrascrivere compilazione/pronto/errore di un load vero.
    const publish = (info) => setEngineInfo((previous) => (
      previous.phase === 'idle' || previous.phase === 'downloading' ? info : previous
    ));
    const job = (async () => {
      if (await findCachedWasm()) {
        cachedRef.current = true;
        publish({ ...IDLE_ENGINE, cached: true });
        return;
      }
      const startedAt = Date.now();
      publish({ phase: 'downloading', loaded: 0, total: ENGINE_WASM_BYTES, startedAt, error: '' });
      try {
        let blob = await downloadEngineWasm(ffmpegWasmUrl, {
          expectedBytes: ENGINE_WASM_BYTES,
          signal: abort.signal,
          onBytes: (loaded, total) => {
            const now = Date.now();
            if (now - lastBytesReportRef.current < PROGRESS_THROTTLE_MS && loaded < total) {
              return;
            }
            lastBytesReportRef.current = now;
            publish({ phase: 'downloading', loaded, total, startedAt, error: '' });
          },
        });
        // Anche con il SW attivo: il suo put asincrono potrebbe non essere
        // ancora visibile quando parte l'export.
        if (!(await findCachedWasm())) {
          await storeWasmInCache(blob, { force: true });
        }
        blob = null;
        cachedRef.current = Boolean(await findCachedWasm());
        publish({ ...IDLE_ENGINE, cached: cachedRef.current });
      } catch (error) {
        // Il vero load riproverà con i suoi messaggi: qui niente stato d'errore.
        publish({ ...IDLE_ENGINE, cached: cachedRef.current });
        throw error;
      }
    })();
    prefetchRef.current = job;
    job.catch(() => {}).finally(() => {
      if (prefetchRef.current === job) prefetchRef.current = null;
      if (prefetchAbortRef.current === abort) prefetchAbortRef.current = null;
    });
    return job;
  }, []);

  useEffect(() => {
    // Motore già in cache da una visita precedente: la UI lo dice subito
    // ("si avvia in pochi secondi") invece di promettere un download.
    let cancelled = false;
    findCachedWasm().then((cached) => {
      if (cancelled || !cached) return;
      cachedRef.current = true;
      setEngineInfo((previous) => (previous.phase === 'idle' ? { ...previous, cached: true } : previous));
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      generationRef.current += 1;
      downloadAbortRef.current?.abort();
      downloadAbortRef.current = null;
      prefetchAbortRef.current?.abort();
      prefetchAbortRef.current = null;
      loadPromiseRef.current = null;
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
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    try {
      ffmpegRef.current?.terminate();
    } catch {
      // ignore
    }
    ffmpegRef.current = null;
    loadPromiseRef.current = null;
    setEngineInfo({ ...IDLE_ENGINE, cached: cachedRef.current });
  }, []);

  return {
    ffmpegRef,
    engineInfo,
    technicalLog,
    setTechnicalLog,
    ensureReady,
    prefetchEngine,
    resetAfterAbort,
  };
}

/**
 * Esegue ffmpeg con avanzamento REALE: `-progress pipe:1` scrive righe
 * terminate da \n ogni ~0,5s (le stats su stderr no: finiscono con \r e il
 * buffer TTY di Emscripten le rilascia solo a fine job).
 * onProgress(frac, seconds) riceve i secondi di OUTPUT già scritti.
 */
export { runFfmpeg, runFfprobe } from '../lib/ffmpegTask.js';

export async function safeDelete(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    return false;
  }
  return true;
}
