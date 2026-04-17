import { useCallback, useEffect, useRef, useState } from 'react';

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined') {
    return '';
  }
  for (const candidate of MIME_CANDIDATES) {
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
    setError('');
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Il browser non supporta l’accesso al microfono.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('Il browser non supporta MediaRecorder.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const mimeType = pickSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mimeRef.current = recorder.mimeType || mimeType;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener('stop', () => {
        const finalMime = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: finalMime });
        stopMonitors();
        releaseStream();
        setIsRecording(false);
        setIsPaused(false);
        const durationSeconds = pausedElapsedRef.current;
        pausedElapsedRef.current = 0;
        const resolver = resolveStopRef.current;
        resolveStopRef.current = null;
        if (resolver) {
          resolver({
            blob,
            mimeType: finalMime,
            extension: extensionForMime(finalMime),
            durationSeconds,
          });
        }
      });

      recorder.addEventListener('error', (event) => {
        const err = event?.error ?? event;
        setError(err?.message || 'Errore di registrazione.');
      });

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
          const source = audioContext.createMediaStreamSource(stream);
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          audioContextRef.current = audioContext;
          analyserRef.current = analyser;

          const buffer = new Uint8Array(analyser.frequencyBinCount);
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
            setLevel(peak);
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
      setError(
        startError?.name === 'NotAllowedError'
          ? 'Permesso microfono negato. Abilita il microfono per registrare.'
          : startError?.message || 'Impossibile avviare la registrazione.',
      );
      releaseStream();
      stopMonitors();
      setIsRecording(false);
      setIsPaused(false);
    }
  }, [releaseStream, stopMonitors]);

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
        resolve(null);
      }
    });
  }, [releaseStream, stopMonitors]);

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
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch (error) {
        // ignore
      }
    }
    resolveStopRef.current = null;
    chunksRef.current = [];
    stopMonitors();
    releaseStream();
    setIsRecording(false);
    setIsPaused(false);
    setElapsedSeconds(0);
    pausedElapsedRef.current = 0;
  }, [releaseStream, stopMonitors]);

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
