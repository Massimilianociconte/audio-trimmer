import { useCallback, useEffect, useRef, useState } from 'react';

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

function isIOSDevice() {
  try {
    const ua = String(globalThis.navigator?.userAgent ?? '');
    if (/iPad|iPhone|iPod/.test(ua)) {
      return true;
    }
    const platform = String(globalThis.navigator?.platform ?? '');
    return /^Mac/.test(platform) && Number(globalThis.navigator?.maxTouchPoints ?? 0) > 1;
  } catch {
    return false;
  }
}

function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }
  // Su iOS webm/opus non esistono: prova prima mp4 così il blob resta riproducibile.
  const candidates = isIOSDevice()
    ? ['audio/mp4', 'audio/mpeg', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    : MIME_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    } catch (error) {
      // ignore, try next
    }
  }
  return '';
}

function extensionForMime(mime) {
  if (!mime) {
    return 'webm';
  }
  if (mime.includes('webm')) {
    return 'webm';
  }
  if (mime.includes('ogg')) {
    return 'ogg';
  }
  if (mime.includes('mp4')) {
    return 'm4a';
  }
  if (mime.includes('mpeg')) {
    return 'mp3';
  }
  return 'webm';
}

export function useRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const mimeRef = useRef('');
  const startTimestampRef = useRef(0);
  const pausedElapsedRef = useRef(0);
  const intervalRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const levelFrameRef = useRef(0);
  const resolveStopRef = useRef(null);
  const startPendingRef = useRef(false);
  const sessionRef = useRef(0);
  const listenersRef = useRef(null);

  const clearRecorder = useCallback(() => {
    listenersRef.current?.();
    listenersRef.current = null;
    recorderRef.current = null;
    chunksRef.current.length = 0;
    chunksRef.current = [];
  }, []);

  const stopMonitors = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (levelFrameRef.current) {
      window.cancelAnimationFrame(levelFrameRef.current);
      levelFrameRef.current = 0;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (error) {
          // ignore
        }
      });
    }
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (startPendingRef.current || recorderRef.current?.state === 'recording' || recorderRef.current?.state === 'paused') {
      return;
    }
    setError('');
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Il browser non supporta l’accesso al microfono.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('Il browser non supporta MediaRecorder.');
      return;
    }

    const session = ++sessionRef.current;
    startPendingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (session !== sessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const mimeType = pickSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mimeRef.current = recorder.mimeType || mimeType;
      recorderRef.current = recorder;
      const chunks = [];
      chunksRef.current = chunks;

      const handleData = (event) => {
        if (session === sessionRef.current && event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      const handleStop = () => {
        if (session !== sessionRef.current) {
          return;
        }
        const finalMime = recorder.mimeType || mimeType || 'audio/webm';
        const resolver = resolveStopRef.current;
        const blob = resolver ? new Blob(chunks, { type: finalMime }) : null;
        chunks.length = 0;
        clearRecorder();
        stopMonitors();
        releaseStream();
        setIsRecording(false);
        setIsPaused(false);
        const durationSeconds = pausedElapsedRef.current;
        pausedElapsedRef.current = 0;
        resolveStopRef.current = null;
        if (resolver) {
          resolver({
            blob,
            mimeType: finalMime,
            extension: extensionForMime(finalMime),
            durationSeconds,
          });
        }
      };

      const handleError = (event) => {
        if (session !== sessionRef.current) {
          return;
        }
        const err = event?.error ?? event;
        setError(err?.message || 'Errore di registrazione.');
        // microfono/loop fermi: niente interval, rAF, AudioContext o mic aperti.
        stopMonitors();
        releaseStream();
        resolveStopRef.current?.(null);
        resolveStopRef.current = null;
        chunks.length = 0;
        clearRecorder();
        setIsRecording(false);
        setIsPaused(false);
      };
      recorder.addEventListener('dataavailable', handleData);
      recorder.addEventListener('stop', handleStop);
      recorder.addEventListener('error', handleError);
      listenersRef.current = () => {
        recorder.removeEventListener('dataavailable', handleData);
        recorder.removeEventListener('stop', handleStop);
        recorder.removeEventListener('error', handleError);
      };

      startTimestampRef.current = Date.now();
      pausedElapsedRef.current = 0;
      setElapsedSeconds(0);
      intervalRef.current = window.setInterval(() => {
        if (recorderRef.current?.state === 'recording') {
          const now = Date.now();
          const running = (now - startTimestampRef.current) / 1000;
          pausedElapsedRef.current = running;
          setElapsedSeconds(running);
        }
      }, 200);

      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          const audioContext = new AudioContextClass();
          audioContextRef.current = audioContext;
          // Su iOS resta suspended senza resume esplicito dopo il gesto utente.
          try {
            await audioContext.resume?.()?.catch?.(() => {});
          } catch {
            // ignore
          }
          if (session !== sessionRef.current) {
            return;
          }
          const source = audioContext.createMediaStreamSource(stream);
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyserRef.current = analyser;

          const buffer = new Uint8Array(analyser.frequencyBinCount);
          let lastLevelAt = 0;
          let lastLevel = -1;
          const sample = () => {
            const analyserInstance = analyserRef.current;
            if (!analyserInstance) {
              return;
            }
            analyserInstance.getByteTimeDomainData(buffer);
            let peak = 0;
            for (let index = 0; index < buffer.length; index += 1) {
              const normalized = Math.abs(buffer[index] - 128) / 128;
              if (normalized > peak) {
                peak = normalized;
              }
            }
            // ~15 aggiornamenti/s bastano al vu-meter: 60 setState/s
            // pesano sui telefoni proprio mentre registrano.
            const now = performance.now();
            if (now - lastLevelAt >= 66 && Math.abs(peak - lastLevel) >= 0.01) {
              lastLevelAt = now;
              lastLevel = peak;
              setLevel(peak);
            }
            levelFrameRef.current = window.requestAnimationFrame(sample);
          };
          levelFrameRef.current = window.requestAnimationFrame(sample);
        }
      } catch (monitorError) {
        // Level meter is optional, ignore failures
      }

      recorder.start(1000);
      setIsRecording(true);
      setIsPaused(false);
    } catch (startError) {
      if (session !== sessionRef.current) {
        return;
      }
      setError(
        startError?.name === 'NotAllowedError'
          ? 'Permesso microfono negato. Abilita il microfono per registrare.'
          : startError?.message || 'Impossibile avviare la registrazione.',
      );
      releaseStream();
      stopMonitors();
      setIsRecording(false);
      setIsPaused(false);
      clearRecorder();
    } finally {
      if (session === sessionRef.current) {
        startPendingRef.current = false;
      }
    }
  }, [clearRecorder, releaseStream, stopMonitors]);

  const stop = useCallback(() => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        resolve(null);
        return;
      }
      resolveStopRef.current = resolve;
      try {
        recorder.stop();
      } catch (stopError) {
        setError(stopError?.message || 'Errore nello stop della registrazione.');
        resolveStopRef.current = null;
        stopMonitors();
        releaseStream();
        setIsRecording(false);
        setIsPaused(false);
        clearRecorder();
        resolve(null);
      }
    });
  }, [clearRecorder, releaseStream, stopMonitors]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.pause();
      setIsPaused(true);
    }
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'paused') {
      startTimestampRef.current = Date.now() - pausedElapsedRef.current * 1000;
      recorder.resume();
      setIsPaused(false);
    }
  }, []);

  const cancel = useCallback(() => {
    sessionRef.current += 1;
    startPendingRef.current = false;
    const recorder = recorderRef.current;
    clearRecorder();
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch (error) {
        // ignore
      }
    }
    resolveStopRef.current?.(null);
    resolveStopRef.current = null;
    chunksRef.current = [];
    stopMonitors();
    releaseStream();
    setIsRecording(false);
    setIsPaused(false);
    setElapsedSeconds(0);
    pausedElapsedRef.current = 0;
  }, [clearRecorder, releaseStream, stopMonitors]);

  useEffect(() => {
    return () => {
      cancel();
    };
  }, [cancel]);

  return {
    start,
    stop,
    pause,
    resume,
    cancel,
    isRecording,
    isPaused,
    elapsedSeconds,
    level,
    error,
  };
}
