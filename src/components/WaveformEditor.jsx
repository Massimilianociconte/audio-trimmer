import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.esm.js';
import { shouldUseNativePreview } from '../lib/device.js';

const CUT_COLOR = 'rgba(239, 108, 47, 0.85)';
const CUT_COLOR_SOFT = 'rgba(239, 108, 47, 0.25)';
const BOOKMARK_COLOR = 'rgba(15, 140, 98, 0.85)';
const BOOKMARK_COLOR_SOFT = 'rgba(15, 140, 98, 0.18)';
const LOOP_COLOR = 'rgba(201, 73, 15, 0.18)';

export const WaveformEditor = forwardRef(function WaveformEditor(
  {
    src,
    blob,
    duration,
    cuts,
    bookmarks,
    loopRegion,
    playbackRate,
    zoom,
    onReady,
    onTimeUpdate,
    onPlayStateChange,
    onCutMove,
    onAddCutAt,
    onBookmarkJump,
    onWaveformClick,
    onLoadingProgress,
    onWaveformError,
    onDecodePending,
    sampleRate = 8000,
  },
  ref,
) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const regionsPluginRef = useRef(null);
  const cutRegionsRef = useRef(new Map());
  const bookmarkRegionsRef = useRef(new Map());
  const loopRegionRef = useRef(null);
  const callbacksRef = useRef({});
  const isReadyRef = useRef(false);
  const latestRateRef = useRef(playbackRate);
  const latestZoomRef = useRef(zoom);
  const [readyRevision, setReadyRevision] = useState(0);
  const [isDecoded, setIsDecoded] = useState(false);
  // Se il browser rifiuta la frequenza ridotta si ripiega a 8 kHz (una volta).
  const [fallbackRate, setFallbackRate] = useState(null);
  const decodeRate = fallbackRate ?? sampleRate;

  callbacksRef.current = {
    onReady,
    onTimeUpdate,
    onPlayStateChange,
    onCutMove,
    onAddCutAt,
    onBookmarkJump,
    onWaveformClick,
    onLoadingProgress,
    onWaveformError,
    onDecodePending,
  };
  latestRateRef.current = playbackRate;
  latestZoomRef.current = zoom;

  function isInstanceReady(instance) {
    if (!instance) {
      return false;
    }
    try {
      return instance.getDuration() > 0;
    } catch (error) {
      return false;
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      play: () => wsRef.current?.play(),
      pause: () => wsRef.current?.pause(),
      togglePlay: () => wsRef.current?.playPause(),
      seekTo: (seconds) => {
        const ws = wsRef.current;
        if (!ws) {
          return;
        }
        const duration = ws.getDuration();
        if (!duration) {
          return;
        }
        ws.setTime(Math.max(0, Math.min(seconds, duration)));
      },
      skip: (deltaSeconds) => {
        const ws = wsRef.current;
        if (!ws) {
          return;
        }
        const duration = ws.getDuration() || 0;
        const current = ws.getCurrentTime();
        ws.setTime(Math.max(0, Math.min(current + deltaSeconds, duration)));
      },
      getCurrentTime: () => wsRef.current?.getCurrentTime() ?? 0,
      isPlaying: () => Boolean(wsRef.current?.isPlaying()),
      getDuration: () => wsRef.current?.getDuration() ?? 0,
    }),
    [],
  );

  useEffect(() => {
    if (!containerRef.current || !src) {
      return undefined;
    }

    isReadyRef.current = false;
    setIsDecoded(false);
    let disposed = false;
    let errorHandled = false;
    let lastProgress = -1;
    let lastProgressAt = 0;

    const regionsPlugin = RegionsPlugin.create();
    // Intervalli adattivi (default del plugin in base ai px/secondo): con un
    // intervallo fisso di 1s una lezione di 2h creava 7.200 tacche DOM
    // ricalcolate a ogni zoom/scroll, pesantissime sui dispositivi deboli.
    const timelinePlugin = TimelinePlugin.create({
      height: 16,
      insertPosition: 'beforebegin',
      style: {
        fontSize: '10px',
        color: '#715742',
      },
    });
    const hoverPlugin = HoverPlugin.create({
      lineColor: '#ef6c2f',
      lineWidth: 1,
      labelBackground: 'rgba(255, 252, 247, 0.94)',
      labelColor: '#22170d',
      labelSize: '10px',
    });

    const instance = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#c9967a',
      progressColor: '#ef6c2f',
      cursorColor: '#22170d',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      // Niente barRadius: le barre arrotondate costano un path per barra.
      height: 120,
      minPxPerSec: Math.max(0, Number(latestZoomRef.current) || 0),
      // Il PCM decodificato serve solo al disegno: a bassa frequenza pesa molto meno.
      sampleRate: decodeRate,
      normalize: true,
      dragToSeek: true,
      plugins: [regionsPlugin, timelinePlugin, hoverPlugin],
    });

    // WaveSurfer 7's non-abortable decode can finish after destroy() and call
    // render() on a detached renderer. Suppress that late canvas allocation.
    const renderer = instance.getRenderer();
    const renderWaveform = renderer.render.bind(renderer);
    renderer.render = (...args) => disposed ? Promise.resolve() : renderWaveform(...args);

    wsRef.current = instance;
    regionsPluginRef.current = regionsPlugin;
    cutRegionsRef.current = new Map();
    bookmarkRegionsRef.current = new Map();
    loopRegionRef.current = null;

    const handleReady = () => {
      if (disposed) return;
      isReadyRef.current = true;
      try {
        const rate = latestRateRef.current;
        if (typeof rate === 'number' && rate > 0) {
          instance.setPlaybackRate(rate, true);
        }
      } catch (error) {
        // ignore: rate will be re-applied on the next prop update
      }
      try {
        const nextZoom = latestZoomRef.current;
        if (typeof nextZoom === 'number' && nextZoom > 0 && instance.getDuration() > 0) {
          instance.zoom(nextZoom);
        }
      } catch (error) {
        // ignore: zoom will re-apply when the user moves the slider
      }
      setIsDecoded(true);
      callbacksRef.current.onReady?.(instance.getDuration());
      setReadyRevision((revision) => revision + 1);
    };
    const handlePlay = () => callbacksRef.current.onPlayStateChange?.(true);
    const handlePause = () => callbacksRef.current.onPlayStateChange?.(false);
    const handleFinish = () => callbacksRef.current.onPlayStateChange?.(false);
    const handleTime = (time) => callbacksRef.current.onTimeUpdate?.(time);
    const handleLoading = (percent) => {
      if (disposed) return;
      const numeric = Number(percent);
      if (!Number.isFinite(numeric)) {
        return;
      }
      // wavesurfer v7 emette 0..100 sul fetch + 'decode' prima di 'ready'
      const frac = numeric / 100;
      const now = performance.now();
      if (frac < 1 && (frac - lastProgress < 0.02 || now - lastProgressAt < 100)) return;
      lastProgress = frac;
      lastProgressAt = now;
      callbacksRef.current.onLoadingProgress?.(Math.min(1, Math.max(0, frac)));
    };
    const handleDecode = () => {
      if (!disposed) callbacksRef.current.onLoadingProgress?.(0.95);
    };
    const handleDecodeError = (error) => {
      if (disposed || errorHandled || error?.name === 'AbortError') return;
      errorHandled = true;
      if (decodeRate < 8000 && !shouldUseNativePreview({ sizeBytes: blob?.size ?? 0, durationSeconds: duration, sampleRate: 8000 })) {
        // Frequenza ridotta non accettata da questo browser: riprova a 8 kHz.
        setFallbackRate(8000);
        return;
      }
      setIsDecoded(true);
      callbacksRef.current.onWaveformError?.(
        error?.message || String(error) || 'Decodifica anteprima non riuscita',
      );
    };

    instance.on('ready', handleReady);
    instance.on('loading', handleLoading);
    instance.on('decode', handleDecode);
    instance.on('error', handleDecodeError);
    instance.on('play', handlePlay);
    instance.on('pause', handlePause);
    instance.on('finish', handleFinish);
    instance.on('timeupdate', handleTime);

    const handleInteraction = (time) => {
      callbacksRef.current.onWaveformClick?.(time);
    };
    instance.on('interaction', handleInteraction);

    regionsPlugin.on('region-updated', (region) => {
      if (typeof region.id !== 'string') {
        return;
      }
      if (region.id.startsWith('cut-')) {
        const cutId = region.id.slice(4);
        callbacksRef.current.onCutMove?.(cutId, region.start);
      }
    });

    regionsPlugin.on('region-clicked', (region, event) => {
      event?.stopPropagation?.();
      if (typeof region.id !== 'string') {
        return;
      }
      if (region.id.startsWith('bookmark-')) {
        const bookmarkId = region.id.slice(9);
        callbacksRef.current.onBookmarkJump?.(bookmarkId);
      } else if (region.id.startsWith('cut-')) {
        instance.setTime(region.start);
      }
    });

    // Reuse the File/Blob and metadata already read by App: fetching its blob URL
    // otherwise creates another full response Blob plus a progress stream clone.
    const reportPending = callbacksRef.current.onDecodePending;
    // StrictMode tears down its first effect synchronously: avoid starting a
    // decode for that abandoned instance before the replayed effect mounts.
    Promise.resolve().then(() => {
      if (disposed) return;
      reportPending?.(true);
      return (blob
        ? instance.loadBlob(blob, undefined, duration)
        : instance.load(src, undefined, duration))
        .catch(handleDecodeError)
        .finally(() => reportPending?.(false));
    });

    return () => {
      disposed = true;
      isReadyRef.current = false;
      instance.un('ready', handleReady);
      instance.un('loading', handleLoading);
      instance.un('decode', handleDecode);
      instance.un('error', handleDecodeError);
      instance.un('play', handlePlay);
      instance.un('pause', handlePause);
      instance.un('finish', handleFinish);
      instance.un('timeupdate', handleTime);
      instance.un('interaction', handleInteraction);
      try {
        instance.destroy();
      } catch (error) {
        // ignore: instance may already be torn down
      }
      wsRef.current = null;
      regionsPluginRef.current = null;
      cutRegionsRef.current = new Map();
      bookmarkRegionsRef.current = new Map();
      loopRegionRef.current = null;
    };
  }, [src, blob, decodeRate]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || typeof playbackRate !== 'number' || playbackRate <= 0) {
      return;
    }
    if (!isInstanceReady(ws)) {
      return;
    }
    try {
      ws.setPlaybackRate(playbackRate, true);
    } catch (error) {
      // ignore: will be re-applied when ready fires
    }
  }, [playbackRate, readyRevision]);

  useEffect(() => {
    const ws = wsRef.current;
    // zoom 0 = adatta alla larghezza (va applicato anche per tornare alla panoramica).
    if (!ws || typeof zoom !== 'number' || zoom < 0) {
      return;
    }
    if (!isInstanceReady(ws)) {
      return;
    }
    try {
      ws.zoom(zoom);
    } catch (error) {
      // ignore: wavesurfer throws when the audio is not fully loaded yet
    }
  }, [zoom, readyRevision]);

  useEffect(() => {
    const regionsPlugin = regionsPluginRef.current;
    if (!regionsPlugin) {
      return;
    }
    const registry = cutRegionsRef.current;
    const nextIds = new Set();

    cuts.forEach((cut) => {
      if (typeof cut.position !== 'number' || !Number.isFinite(cut.position)) {
        return;
      }
      const regionId = `cut-${cut.id}`;
      nextIds.add(regionId);
      const existing = registry.get(regionId);
      if (existing) {
        if (Math.abs(existing.start - cut.position) > 0.01) {
          existing.setOptions({ start: cut.position, end: cut.position });
        }
        return;
      }
      const region = regionsPlugin.addRegion({
        id: regionId,
        start: cut.position,
        end: cut.position,
        color: CUT_COLOR_SOFT,
        drag: true,
        resize: false,
      });
      if (region?.element) {
        const handle = region.element;
        handle.style.borderLeft = `2px solid ${CUT_COLOR}`;
        handle.style.cursor = 'ew-resize';
      }
      registry.set(regionId, region);
    });

    registry.forEach((region, regionId) => {
      if (!nextIds.has(regionId)) {
        try {
          region.remove();
        } catch (error) {
          // ignore stale region
        }
        registry.delete(regionId);
      }
    });
  }, [cuts, src, readyRevision]);

  useEffect(() => {
    const regionsPlugin = regionsPluginRef.current;
    if (!regionsPlugin) {
      return;
    }
    const registry = bookmarkRegionsRef.current;
    const nextIds = new Set();

    bookmarks.forEach((bookmark) => {
      if (typeof bookmark.position !== 'number' || !Number.isFinite(bookmark.position)) {
        return;
      }
      const regionId = `bookmark-${bookmark.id}`;
      nextIds.add(regionId);
      const label = bookmark.note ? bookmark.note.slice(0, 40) : 'Segnalibro';
      const existing = registry.get(regionId);
      if (existing) {
        existing.setOptions({
          start: bookmark.position,
          end: bookmark.position,
          content: label,
        });
        return;
      }
      const region = regionsPlugin.addRegion({
        id: regionId,
        start: bookmark.position,
        end: bookmark.position,
        color: BOOKMARK_COLOR_SOFT,
        drag: false,
        resize: false,
        content: label,
      });
      if (region?.element) {
        region.element.style.borderLeft = `2px dashed ${BOOKMARK_COLOR}`;
      }
      registry.set(regionId, region);
    });

    registry.forEach((region, regionId) => {
      if (!nextIds.has(regionId)) {
        try {
          region.remove();
        } catch (error) {
          // ignore stale region
        }
        registry.delete(regionId);
      }
    });
  }, [bookmarks, src, readyRevision]);

  useEffect(() => {
    const regionsPlugin = regionsPluginRef.current;
    if (!regionsPlugin) {
      return;
    }
    if (loopRegionRef.current) {
      try {
        loopRegionRef.current.remove();
      } catch (error) {
        // ignore stale loop region
      }
      loopRegionRef.current = null;
    }
    if (
      loopRegion &&
      typeof loopRegion.start === 'number' &&
      typeof loopRegion.end === 'number' &&
      loopRegion.end > loopRegion.start
    ) {
      try {
        const region = regionsPlugin.addRegion({
          id: 'loop-region',
          start: loopRegion.start,
          end: loopRegion.end,
          color: LOOP_COLOR,
          drag: false,
          resize: false,
        });
        loopRegionRef.current = region;
      } catch (error) {
        // ignore: addRegion may throw before audio is loaded
      }
    }
  }, [loopRegion, src, readyRevision]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !loopRegion) {
      return undefined;
    }
    const handleTimeUpdate = (time) => {
      if (time >= loopRegion.end - 0.02) {
        ws.setTime(loopRegion.start);
      }
    };
    ws.on('timeupdate', handleTimeUpdate);
    return () => {
      ws.un('timeupdate', handleTimeUpdate);
    };
  }, [loopRegion, src]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const handleDoubleClick = (event) => {
      const ws = wsRef.current;
      const onAdd = callbacksRef.current.onAddCutAt;
      if (!ws || typeof onAdd !== 'function') {
        return;
      }
      let duration = 0;
      try {
        duration = ws.getDuration() || 0;
      } catch {
        return;
      }
      if (!(duration > 0)) {
        return;
      }
      // Con lo zoom WaveSurfer scrolla: il rapporto va calcolato sullo scrollWidth
      // interno, non sulla larghezza visibile del container (bug taglio fuori punto).
      try {
        const wrapper = ws.getWrapper?.();
        const scrollLeft = ws.getScroll?.() ?? wrapper?.scrollLeft ?? 0;
        const rect = (wrapper ?? container).getBoundingClientRect();
        const totalWidth = wrapper?.scrollWidth ?? rect.width;
        if (!(totalWidth > 0)) {
          return;
        }
        const ratio = (event.clientX - rect.left + scrollLeft) / totalWidth;
        const clamped = Math.min(1, Math.max(0, ratio));
        onAdd(clamped * duration);
      } catch {
        const rect = container.getBoundingClientRect();
        if (!(rect.width > 0)) {
          return;
        }
        const ratio = (event.clientX - rect.left) / rect.width;
        onAdd(Math.min(1, Math.max(0, ratio)) * duration);
      }
    };
    container.addEventListener('dblclick', handleDoubleClick);
    return () => {
      container.removeEventListener('dblclick', handleDoubleClick);
    };
  }, [src]);

  return (
    <div
      className="waveform-wrapper"
      title="Doppio click per aggiungere un taglio"
      role="img"
      aria-label="Forma d'onda dell'audio caricato. Usa i pulsanti Taglia qui e Segnalibro o gli slider dei punti di taglio per modificare."
    >
      <div ref={containerRef} className="waveform-container" />
      {!isDecoded ? (
        <div className="waveform-skeleton" aria-hidden="true">
          <span>Disegno la forma d’onda…</span>
        </div>
      ) : null}
    </div>
  );
});
