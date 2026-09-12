import { useCallback, useEffect, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { clamp } from '../lib/time.js';

export function useFfmpegEngine() {
  const ffmpegRef = useRef(null);
  const loadPromiseRef = useRef(null);
  const [engineState, setEngineState] = useState('idle');
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [technicalLog, setTechnicalLog] = useState('');

  const ensureReady = useCallback(async ({ silent = false } = {}) => {
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
        loadPromiseRef.current = ffmpeg
          .load({ coreURL: ffmpegCoreUrl, wasmURL: ffmpegWasmUrl })
          .finally(() => {
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
