import { useCallback, useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { clamp } from '../lib/time.js';
import { shouldPreloadEngine } from '../lib/device.js';

// Cache dei Blob URL del core: scaricati una sola volta con progresso reale,
// poi riusati per ogni load (niente re-download da 31MB ad ogni terminate).
const coreBlobCache = {
  coreUrl: '',
  wasmUrl: '',
  promise: null,
};

function reportEngineBytes(onEngineProgress, loaded, total) {
  try {
    onEngineProgress?.(loaded, total);
  } catch {
    // il reporting non deve mai rompere il load
  }
}

async function fetchToBlobUrl(url, { onChunk, signal } = {}) {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`Download motore non riuscito (${response.status})`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || typeof response.body.getReader !== 'function') {
    const blob = await response.blob();
    onChunk?.(blob.size, total || blob.size);
    return { objectUrl: URL.createObjectURL(blob), bytes: blob.size, total: total || blob.size };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new DOMException('Download annullato', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value && value.byteLength) {
      chunks.push(value);
      loaded += value.byteLength;
      onChunk?.(loaded, total);
    }
  }
  try {
    reader.releaseLock();
  } catch {
    // ignore
  }
  const blob = new Blob(chunks);
  return { objectUrl: URL.createObjectURL(blob), bytes: loaded, total: total || loaded };
}

function ensureCoreBlobs({ onEngineProgress, signal } = {}) {
  if (coreBlobCache.coreUrl && coreBlobCache.wasmUrl) {
    return Promise.resolve({ coreUrl: coreBlobCache.coreUrl, wasmUrl: coreBlobCache.wasmUrl });
  }
  if (!coreBlobCache.promise) {
    coreBlobCache.promise = (async () => {
      let coreLoaded = 0;
      let coreTotal = 0;
      let wasmLoaded = 0;
      let wasmTotal = 0;
      const report = () => reportEngineBytes(onEngineProgress, coreLoaded + wasmLoaded, coreTotal + wasmTotal);
      const [core, wasm] = await Promise.all([
        fetchToBlobUrl(ffmpegCoreUrl, {
          signal,
          onChunk: (loaded, total) => {
            coreLoaded = loaded;
            coreTotal = total;
            report();
          },
        }),
        fetchToBlobUrl(ffmpegWasmUrl, {
          signal,
          onChunk: (loaded, total) => {
            wasmLoaded = loaded;
            wasmTotal = total;
            report();
          },
        }),
      ]);
      coreBlobCache.coreUrl = core.objectUrl;
      coreBlobCache.wasmUrl = wasm.objectUrl;
      reportEngineBytes(onEngineProgress, core.bytes + wasm.bytes, core.total + wasm.total);
      return { coreUrl: core.objectUrl, wasmUrl: wasm.objectUrl };
    })().catch((error) => {
      coreBlobCache.promise = null;
      throw error;
    });
  }
  return coreBlobCache.promise;
}

export function useFfmpegEngine() {
  const ffmpegRef = useRef(null);
  const loadPromiseRef = useRef(null);
  const [engineState, setEngineState] = useState('idle');
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [technicalLog, setTechnicalLog] = useState('');

  const ensureReady = useCallback(async ({ silent = false, onEngineProgress = null, signal = null } = {}) => {
    let ffmpeg = ffmpegRef.current;
    if (!ffmpeg) {
      ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        const compact = String(message ?? '').trim();
        if (compact) {
          setTechnicalLog(compact);
        }
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
          let coreURL = ffmpegCoreUrl;
          let wasmURL = ffmpegWasmUrl;
          try {
            const blobs = await ensureCoreBlobs({ onEngineProgress, signal });
            coreURL = blobs.coreUrl;
            wasmURL = blobs.wasmUrl;
          } catch (fetchError) {
            // Fallback agli URL statici (es. fetch con progress non supportata):
            // il load diretto resta possibile senza percentuale.
            if (fetchError?.name === 'AbortError') {
              throw fetchError;
            }
            reportEngineBytes(onEngineProgress, 0, 0);
          }
          return ffmpeg.load({ coreURL, wasmURL });
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
