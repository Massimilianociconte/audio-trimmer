import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import HoverPlugin from 'wavesurfer.js/dist/plugins/hover.esm.js';

const CUT_COLOR = 'rgba(239, 108, 47, 0.85)';
const CUT_COLOR_SOFT = 'rgba(239, 108, 47, 0.25)';
const BOOKMARK_COLOR = 'rgba(15, 140, 98, 0.85)';
const BOOKMARK_COLOR_SOFT = 'rgba(15, 140, 98, 0.18)';
const LOOP_COLOR = 'rgba(201, 73, 15, 0.18)';

export const WaveformEditor = forwardRef(function WaveformEditor(
  {
    src,
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

  callbacksRef.current = {
    onReady,
    onTimeUpdate,
    onPlayStateChange,
    onCutMove,
    onAddCutAt,
    onBookmarkJump,
    onWaveformClick,
  };

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

    const regionsPlugin = RegionsPlugin.create();
    const timelinePlugin = TimelinePlugin.create({
      height: 16,
      insertPosition: 'beforebegin',
      timeInterval: 1,
      primaryLabelInterval: 5,
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
      url: src,
      waveColor: '#c9967a',
      progressColor: '#ef6c2f',
      cursorColor: '#22170d',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 120,
      normalize: true,
      dragToSeek: true,
      plugins: [regionsPlugin, timelinePlugin, hoverPlugin],
    });

    wsRef.current = instance;
    regionsPluginRef.current = regionsPlugin;
    cutRegionsRef.current = new Map();
    bookmarkRegionsRef.current = new Map();
    loopRegionRef.current = null;

    const handleReady = () => {
      callbacksRef.current.onReady?.(instance.getDuration());
    };
    const handlePlay = () => callbacksRef.current.onPlayStateChange?.(true);
    const handlePause = () => callbacksRef.current.onPlayStateChange?.(false);
    const handleFinish = () => callbacksRef.current.onPlayStateChange?.(false);
    const handleTime = (time) => callbacksRef.current.onTimeUpdate?.(time);

    instance.on('ready', handleReady);
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

    return () => {
      instance.un('ready', handleReady);
      instance.un('play', handlePlay);
      instance.un('pause', handlePause);
      instance.un('finish', handleFinish);
      instance.un('timeupdate', handleTime);
      instance.un('interaction', handleInteraction);
      instance.destroy();
      wsRef.current = null;
      regionsPluginRef.current = null;
      cutRegionsRef.current = new Map();
      bookmarkRegionsRef.current = new Map();
      loopRegionRef.current = null;
    };
  }, [src]);

  useEffect(() => {
    const ws = wsRef.current;
    if (ws && typeof playbackRate === 'number' && playbackRate > 0) {
      ws.setPlaybackRate(playbackRate, true);
    }
  }, [playbackRate, src]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !zoom) {
      return;
    }
    ws.zoom(zoom);
  }, [zoom, src]);

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
        region.remove();
        registry.delete(regionId);
      }
    });
  }, [cuts, src]);

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
        region.remove();
        registry.delete(regionId);
      }
    });
  }, [bookmarks, src]);

  useEffect(() => {
    const regionsPlugin = regionsPluginRef.current;
    if (!regionsPlugin) {
      return;
    }
    if (loopRegionRef.current) {
      loopRegionRef.current.remove();
      loopRegionRef.current = null;
    }
    if (
      loopRegion &&
      typeof loopRegion.start === 'number' &&
      typeof loopRegion.end === 'number' &&
      loopRegion.end > loopRegion.start
    ) {
      const region = regionsPlugin.addRegion({
        id: 'loop-region',
        start: loopRegion.start,
        end: loopRegion.end,
        color: LOOP_COLOR,
        drag: false,
        resize: false,
      });
      loopRegionRef.current = region;
    }
  }, [loopRegion, src]);

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

  return (
    <div className="waveform-wrapper">
      <div ref={containerRef} className="waveform-container" />
    </div>
  );
});
