import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/**
 * Anteprima audio NATIVA per i mobile con file pesanti.
 * Evita la decodifica integrale in PCM (GB di RAM → jetsam/OOM):
 * usa <audio> + MediaElement, stessa interfaccia imperativa del WaveformEditor
 * così play/skip/loop/taglia-qui/segnalibri continuano a funzionare.
 */
export const NativeAudioPreview = forwardRef(function NativeAudioPreview(
  {
    src,
    playbackRate,
    onReady,
    onTimeUpdate,
    onPlayStateChange,
    onPreviewError,
    note = null,
    progress = null,
  },
  ref,
) {
  const audioRef = useRef(null);
  const callbacksRef = useRef({});

  callbacksRef.current = { onReady, onTimeUpdate, onPlayStateChange, onPreviewError };

  useImperativeHandle(
    ref,
    () => ({
      play: () => audioRef.current?.play().catch(() => {}),
      pause: () => audioRef.current?.pause(),
      togglePlay: () => {
        const el = audioRef.current;
        if (!el) {
          return;
        }
        if (el.paused) {
          el.play().catch(() => {});
        } else {
          el.pause();
        }
      },
      seekTo: (seconds) => {
        const el = audioRef.current;
        if (!el || !Number.isFinite(seconds)) {
          return;
        }
        const duration = Number.isFinite(el.duration) ? el.duration : Infinity;
        el.currentTime = Math.max(0, Math.min(seconds, duration));
      },
      skip: (deltaSeconds) => {
        const el = audioRef.current;
        if (!el) {
          return;
        }
        const duration = Number.isFinite(el.duration) ? el.duration : Infinity;
        el.currentTime = Math.max(0, Math.min(el.currentTime + deltaSeconds, duration));
      },
      getCurrentTime: () => audioRef.current?.currentTime ?? 0,
      isPlaying: () => Boolean(audioRef.current && !audioRef.current.paused),
      getDuration: () => audioRef.current?.duration ?? 0,
    }),
    [],
  );

  useEffect(() => {
    const el = audioRef.current;
    if (!el) {
      return undefined;
    }
    const handleLoaded = () => {
      callbacksRef.current.onReady?.(Number.isFinite(el.duration) ? el.duration : 0);
    };
    const handleTime = () => callbacksRef.current.onTimeUpdate?.(el.currentTime);
    const handlePlay = () => callbacksRef.current.onPlayStateChange?.(true);
    const handlePause = () => callbacksRef.current.onPlayStateChange?.(false);
    const handleEnded = () => callbacksRef.current.onPlayStateChange?.(false);
    const handleError = () => callbacksRef.current.onPreviewError?.('Il browser non riesce a leggere l’anteprima audio.');
    el.addEventListener('loadedmetadata', handleLoaded);
    el.addEventListener('timeupdate', handleTime);
    el.addEventListener('play', handlePlay);
    el.addEventListener('pause', handlePause);
    el.addEventListener('ended', handleEnded);
    el.addEventListener('error', handleError);
    el.src = src;
    return () => {
      el.removeEventListener('loadedmetadata', handleLoaded);
      el.removeEventListener('timeupdate', handleTime);
      el.removeEventListener('play', handlePlay);
      el.removeEventListener('pause', handlePause);
      el.removeEventListener('ended', handleEnded);
      el.removeEventListener('error', handleError);
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, [src]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || typeof playbackRate !== 'number' || !(playbackRate > 0)) {
      return;
    }
    try {
      el.playbackRate = playbackRate;
    } catch {
      // ignore
    }
  }, [playbackRate, src]);

  return (
    <div className="native-preview">
      <p className="helper-text native-note">
        {note ?? 'Anteprima leggera: ascolto, tagli ed export funzionano normalmente.'}
      </p>
      {Number.isFinite(progress) ? (
        <span
          className="native-progress"
          role="progressbar"
          aria-label="Preparazione della forma d’onda"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, progress))})` }} />
        </span>
      ) : null}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} controls preload="metadata" playsInline className="native-audio" />
    </div>
  );
});
