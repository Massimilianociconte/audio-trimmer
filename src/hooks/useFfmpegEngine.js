import { useCallback, useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { clamp } from '../lib/time.js';
import { shouldPreloadEngine } from '../lib/device.js';

// Il download del core serve SOLO a scaldare la cache del service worker
// con progresso reale: il load usa poi gli URL statici, gli unici che il
// worker ffmpeg riesce a importare (i Blob URL falliscono con
// "Failed to fetch dynamically imported module" dentro il worker).
const engineWarmCache = {
  promise: null,
};

const ENGINE_FETCH_MAX_ATTEMPTS = 3;
const ENGINE_STALL_TIMEOUT_MS = 20000;
const ENGINE_MIN_WASM_BYTES = 20 * 1024 * 1024;

function reportEngineBytes(onEngineProgress, loaded, total) {
  try {
    onEngineProgress?.(loaded, total);
  } catch {
    // il reporting non deve mai rompere il load
  }
}

function reportEngineStage(onEngineStage, stage) {
  try {
    onEngineStage?.(stage);
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Download resiliente per reti mobili instabili:
 * - retry con backoff + resume via Range (niente restart da 0 a 29/31MB)
 * - watchdog anti-stallo (20s senza byte → tentativo successivo)
 * - i byte vengono LETTI (per la % reale) ma SCARTATI: niente 31MB trattenuti
 *   in heap JS, la persistenza spetta alla CacheFirst del service worker.
 * - il signal utente NON tocca il fetch condiviso: l'annullo sblocca subito
 *   la UI (stale-check) e il download completa in background scaldando la cache.
 */
async function fetchResilientChunks(url, { onChunk } = {}) {
  let total = 0;
  let acceptRanges = false;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (head.ok) {
      total = Number(head.headers.get('content-length')) || 0;
      acceptRanges = /bytes/i.test(head.headers.get('accept-ranges') || '');
    }
  } catch {
    // HEAD opzionale: si prosegue senza totale né resume
  }

  let loaded = 0;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const headers = acceptRanges && loaded > 0 ? { Range: `bytes=${loaded}-` } : {};
    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Download motore non riuscito (HTTP ${response.status})`);
    }
    if (response.status === 200 && loaded > 0) {
      // Server senza resume: si ricomincia da 0
      loaded = 0;
    }
    const reader = response.body.getReader();
    let attemptFailed = false;
    // Il watchdog deve correre ANCHE mentre read() pende (TCP morto):
    // race per-byte, non controllo a fine lettura.
    const readWithStallGuard = async () => {
      let timer = null;
      try {
        return await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('stall')), ENGINE_STALL_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await readWithStallGuard().catch((stallError) => {
          if (stallError?.message === 'stall') {
            return { stalled: true };
          }
          throw stallError;
        });
        if (stalled) {
          attemptFailed = true;
          break;
        }
        if (done) {
          break;
        }
        if (value && value.byteLength) {
          loaded += value.byteLength;
          try {
            onChunk?.(loaded, total || loaded);
          } catch {
            // ignore
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      try {
        await response.body.cancel().catch(() => {});
      } catch {
        // ignore
      }
    }
    if (!attemptFailed) {
      return { loaded, total: total || loaded };
    }
    if (attempt >= ENGINE_FETCH_MAX_ATTEMPTS) {
      throw new Error('Connessione in stallo durante il download del motore');
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000 * attempt);
  }
}

async function warmUrlWithRetry(url, { onChunk } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= ENGINE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetchResilientChunks(url, { onChunk });
    } catch (error) {
      lastError = error;
      if (attempt < ENGINE_FETCH_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError ?? new Error('Download motore non riuscito');
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

function isCorruptEngineError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return /compileerror|failed to fetch dynamically|importscripts|networkerror|aborted/.test(message);
}

/**
 * Scalda la cache del service worker per core+wasm con progresso reale.
 * Ritorna gli URL STATICI (gli unici importabili dal worker ffmpeg).
 */
function warmEngineCache({ onEngineProgress } = {}) {
  if (!engineWarmCache.promise) {
    engineWarmCache.promise = (async () => {
      let coreLoaded = 0;
      let coreTotal = 0;
      let wasmLoaded = 0;
      let wasmTotal = 0;
      const report = () => reportEngineBytes(onEngineProgress, coreLoaded + wasmLoaded, coreTotal + wasmTotal);
      await Promise.all([
        warmUrlWithRetry(ffmpegCoreUrl, {
          onChunk: (loaded, total) => {
            coreLoaded = loaded;
            coreTotal = total;
            report();
          },
        }),
        warmUrlWithRetry(ffmpegWasmUrl, {
          onChunk: (loaded, total) => {
            wasmLoaded = loaded;
            wasmTotal = total;
            report();
          },
        }),
      ]);
      // Integrity gate: wasm tronco (cache avvelenata) deve fallire QUI con retry,
      // non dopo con CompileError criptico a ogni avvio.
      if (wasmLoaded > 0 && wasmLoaded < ENGINE_MIN_WASM_BYTES) {
        await purgeWasmCaches();
        const fresh = await warmUrlWithRetry(ffmpegWasmUrl, {
          onChunk: (loaded, total) => {
            wasmLoaded = loaded;
            wasmTotal = total;
            report();
          },
        });
        if (fresh.loaded < ENGINE_MIN_WASM_BYTES) {
          throw new Error('Motore scaricato incompleto. Controlla la connessione e riprova.');
        }
      }
      reportEngineBytes(onEngineProgress, coreLoaded + wasmLoaded, coreTotal + wasmTotal);
    })().catch((error) => {
      engineWarmCache.promise = null;
      throw error;
    });
  }
  return engineWarmCache.promise;
}

export function useFfmpegEngine() {
  const ffmpegRef = useRef(null);
  const loadPromiseRef = useRef(null);
  const [engineState, setEngineState] = useState('idle');
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [technicalLog, setTechnicalLog] = useState('');

  const ensureReady = useCallback(async ({ silent = false, onEngineProgress = null, onEngineStage = null, signal = null } = {}) => {
    let ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      ffmpeg = new FFmpeg();
      // Throttle: durante compile/esecuzioni lunghe arrivano decine di log al
      // secondo e ogni setState è un re-render nel momento peggiore (picco RAM).
      let lastLogAt = 0;
      ffmpeg.on('log', ({ message }) => {
        const compact = String(message ?? '').trim();
        if (!compact) {
          return;
        }
        const now = Date.now();
        if (now - lastLogAt < 500) {
          return;
        }
        lastLogAt = now;
        setTechnicalLog(compact);
      });
      ffmpeg.on('progress', ({ progress }) => {
        const safe = Number.isFinite(progress) ? clamp(progress, 0, 1) : 0;
        setPhaseProgress((current) => Math.max(current, safe));
      });
      ffmpegRef.current = ffmpeg;
    }

    if (!ffmpeg.loaded) {
      setEngineState('loading');
      if (!silent) {
        setPhaseProgress(0.08);
      }
      if (!loadPromiseRef.current) {
        loadPromiseRef.current = (async () => {
          // Download con progresso reale + cache: su mobile niente preload al boot,
          // il motore si scarica solo al primo uso effettivo (primo file / primo export).
          // Il signal utente NON interrompe il fetch condiviso: l'annullo sblocca
          // subito la UI e il download completa in background scaldando la cache.
          // Il load usa gli URL STATICI (gli unici importabili dal worker ffmpeg).
          try {
            await warmEngineCache({ onEngineProgress });
          } catch (warmError) {
            // Warm fallito: il load diretto resta possibile (da SW o rete),
            // senza percentuale ma senza bloccare l'utente.
            reportEngineBytes(onEngineProgress, 0, 0);
          }
          // La compilazione WASM su CPU lente dura secondi nel silenzio:
          // segnalala come fase esplicita prima del freeze percepito.
          reportEngineStage(onEngineStage, 'compiling');
          try {
            return await ffmpeg.load({ coreURL: ffmpegCoreUrl, wasmURL: ffmpegWasmUrl });
          } catch (loadError) {
            // Cache avvelenata (wasm tronco): purga e riprova UNA volta da rete.
            if (isCorruptEngineError(loadError)) {
              await purgeWasmCaches();
              engineWarmCache.promise = null;
              try {
                await warmEngineCache({ onEngineProgress });
              } catch {
                // ignore: il retry passa comunque da rete/SW
              }
              reportEngineStage(onEngineStage, 'compiling');
              return await ffmpeg.load({ coreURL: ffmpegCoreUrl, wasmURL: ffmpegWasmUrl });
            }
            throw loadError;
          } finally {
            reportEngineStage(onEngineStage, 'ready');
          }
        })().finally(() => {
          loadPromiseRef.current = null;
        });
      }
      try {
        await loadPromiseRef.current;
      } catch (error) {
        setEngineState('idle');
        throw error;
      }
      setEngineState('ready');
      if (!silent) {
        setPhaseProgress(0);
      }
    }
    return ffmpeg;
  }, []);

  useEffect(() => {
    // Niente preload del wasm (31MB + compilazione) su mobile / save-data:
    // è la causa n.1 dei crash "dopo pochi secondi" su iPad/Android.
    if (!shouldPreloadEngine()) {
      return undefined;
    }
    let cancelled = false;
    const preload = () => {
      if (cancelled) {
        return;
      }
      ensureReady({ silent: true }).catch(() => {});
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
      if (ffmpegRef.current) {
        try {
          ffmpegRef.current.terminate();
        } catch {
          // ignore
        }
        ffmpegRef.current = null;
      }
    };
  }, []);

  const runWithLogCapture = useCallback(async (args) => {
    const ffmpeg = await ensureReady();
    const logs = [];
    const capture = ({ message }) => {
      if (typeof message === 'string') {
        logs.push(message);
      }
    };
    ffmpeg.on('log', capture);
    try {
      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) {
        throw new Error(`FFmpeg fallito (codice ${exitCode}): ${logs.slice(-3).join(' | ').slice(0, 300)}`);
      }
      return logs.join('\n');
    } finally {
      ffmpeg.off('log', capture);
    }
  }, [ensureReady]);

  const resetAfterAbort = useCallback(() => {
    // Terminate interrompe un exec in corso; il prossimo ensureReady ricrea il motore.
    try {
      ffmpegRef.current?.terminate();
    } catch {
      // ignore
    }
    ffmpegRef.current = null;
    loadPromiseRef.current = null;
    setEngineState('idle');
  }, []);

  return {
    ffmpegRef,
    engineState,
    setEngineState,
    phaseProgress,
    setPhaseProgress,
    technicalLog,
    setTechnicalLog,
    ensureReady,
    runWithLogCapture,
    resetAfterAbort,
  };
}

export async function safeDelete(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    return false;
  }
  return true;
}
