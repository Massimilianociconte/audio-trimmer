import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import JSZip from 'jszip';
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { buildDownloadName, buildPlan, buildVirtualSegmentName } from './lib/segments.js';
import {
  clamp,
  formatBytes,
  formatClock,
  getExtension,
  parseTimeInput,
  stripExtension,
} from './lib/time.js';
import { WaveformEditor } from './components/WaveformEditor.jsx';
import { PlayerControls } from './components/PlayerControls.jsx';
import { BookmarksPanel } from './components/BookmarksPanel.jsx';
import { AutomationPanel } from './components/AutomationPanel.jsx';
import {
  KEYBOARD_HINTS,
  useKeyboardShortcuts,
} from './hooks/useKeyboardShortcuts.js';
import {
  buildSilenceDetectFilter,
  parseSilenceLog,
  silencesToCutPoints,
} from './lib/silence.js';
import { buildCleanupFilter, getCleanupPreset } from './lib/cleanup.js';

const ACCEPTED_AUDIO_TYPES = [
  'audio/*',
  '.aac',
  '.aif',
  '.aiff',
  '.alac',
  '.amr',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
].join(',');

const INITIAL_MESSAGE = 'Carica un file audio e preparerò tutte le parti in un unico passaggio.';

function createPointId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getAudioMime(file, extension) {
  if (file?.type) {
    return file.type;
  }

  const mimeByExtension = {
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
  };

  return mimeByExtension[extension] ?? 'application/octet-stream';
}

function getFormatLabel(file, extension) {
  if (file?.type?.startsWith('audio/')) {
    return file.type.replace('audio/', '').toUpperCase();
  }

  if (extension) {
    return extension.slice(1).toUpperCase();
  }

  return 'audio';
}

function readAudioDurationFromBrowser(objectUrl) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    let settled = false;

    const timeoutId = window.setTimeout(() => {
      finalize(() => reject(new Error('Timeout metadata browser')));
    }, 15000);

    function finalize(callback) {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.onloadedmetadata = null;
      audio.onerror = null;
      callback();
    }

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = audio.duration;

      if (Number.isFinite(duration) && duration > 0) {
        finalize(() => resolve(duration));
        return;
      }

      finalize(() => reject(new Error('Durata browser non valida')));
    };

    audio.onerror = () => {
      finalize(() => reject(new Error('Metadata browser non disponibili')));
    };

    audio.src = objectUrl;
  });
}

async function safeDelete(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    return false;
  }

  return true;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function formatFfmpegTime(seconds) {
  return Math.max(0, seconds).toFixed(3);
}

export default function App() {
  const ffmpegRef = useRef(null);
  const inputRef = useRef(null);
  const objectUrlRef = useRef('');
  const activeInputRef = useRef('');
  const activeProbeRef = useRef('');
  const dragDepthRef = useRef(0);
  const waveformRef = useRef(null);

  const [engineState, setEngineState] = useState('idle');
  const [statusText, setStatusText] = useState(INITIAL_MESSAGE);
  const [phaseProgress, setPhaseProgress] = useState(0);
  const [technicalLog, setTechnicalLog] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [mode, setMode] = useState('equal');
  const [equalParts, setEqualParts] = useState(2);
  const [customCuts, setCustomCuts] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [zoom, setZoom] = useState(60);
  const [loopRegion, setLoopRegion] = useState(null);
  const [loopDraft, setLoopDraft] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-30);
  const [silenceMinDuration, setSilenceMinDuration] = useState(2);
  const [silenceMinSegment, setSilenceMinSegment] = useState(8);
  const [cleanupPreset, setCleanupPreset] = useState('none');
  const [originalAudioBackup, setOriginalAudioBackup] = useState(null);
  const [lastDetectionSummary, setLastDetectionSummary] = useState('');

  const plan = buildPlan({
    duration: audioFile?.duration ?? 0,
    mode,
    equalParts,
    customCuts,
  });

  const backupUrlRef = useRef(null);
  backupUrlRef.current = originalAudioBackup?.objectUrl ?? null;

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }

      if (backupUrlRef.current && backupUrlRef.current !== objectUrlRef.current) {
        URL.revokeObjectURL(backupUrlRef.current);
        backupUrlRef.current = null;
      }

      if (ffmpegRef.current) {
        ffmpegRef.current.terminate();
        ffmpegRef.current = null;
      }

      activeInputRef.current = '';
      activeProbeRef.current = '';
    };
  }, []);

  async function ensureEngineReady() {
    let ffmpeg = ffmpegRef.current;

    if (!ffmpeg) {
      ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        const compactMessage = message.trim();
        if (compactMessage) {
          setTechnicalLog(compactMessage);
        }
      });
      ffmpeg.on('progress', ({ progress }) => {
        setPhaseProgress((current) => Math.max(current, progress));
      });
      ffmpegRef.current = ffmpeg;
    }

    if (!ffmpeg.loaded) {
      setEngineState('loading');
      setStatusText('Carico il motore locale di taglio. Succede solo la prima volta.');
      setPhaseProgress(0.08);

      await ffmpeg.load({
        coreURL: ffmpegCoreUrl,
        wasmURL: ffmpegWasmUrl,
      });

      setEngineState('ready');
      setStatusText('Motore pronto. Ora puoi analizzare e tagliare il file.');
      setPhaseProgress(0);
    }

    return ffmpeg;
  }

  async function analyzeFile(file) {
    if (!file) {
      return;
    }

    let objectUrl = '';
    let keepObjectUrl = false;

    setErrorText('');
    setLastResult(null);
    setIsBusy(true);
    setStatusText('Analizzo il file e recupero la durata esatta...');
    setPhaseProgress(0.12);

    try {
      const extension = getExtension(file.name);
      const outputExtension = extension || '.audio';
      const baseName = stripExtension(file.name);
      const virtualInputName = `source-${Date.now()}${outputExtension}`;
      const probeOutputName = `probe-${Date.now()}.json`;
      let duration = NaN;
      let technicalMessage = 'File pronto.';
      let formatLabel = getFormatLabel(file, outputExtension);

      objectUrl = URL.createObjectURL(file);

      try {
        duration = await readAudioDurationFromBrowser(objectUrl);
        technicalMessage = 'Durata recuperata direttamente dal browser.';
      } catch {
        technicalMessage = 'Il browser non legge la durata, provo con ffprobe.';
      }

      const ffmpeg = await ensureEngineReady();

      if (activeInputRef.current) {
        await safeDelete(ffmpeg, activeInputRef.current);
      }
      if (activeProbeRef.current) {
        await safeDelete(ffmpeg, activeProbeRef.current);
      }

      await ffmpeg.writeFile(virtualInputName, await fetchFile(file));
      activeInputRef.current = virtualInputName;

      if (!Number.isFinite(duration) || duration <= 0) {
        activeProbeRef.current = probeOutputName;

        const exitCode = await ffmpeg.ffprobe([
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          virtualInputName,
          '-o',
          probeOutputName,
        ]);

        if (exitCode !== 0) {
          throw new Error('Impossibile leggere i metadati del file audio.');
        }

        const probeRaw = await ffmpeg.readFile(probeOutputName, 'utf8');
        duration = Number(String(probeRaw).trim());
        technicalMessage = 'Durata recuperata con ffprobe.';
      }

      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Durata non valida. Prova con un file audio differente.');
      }

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = objectUrl;
      keepObjectUrl = true;

      startTransition(() => {
        setAudioFile({
          baseName,
          duration,
          extension: outputExtension,
          formatLabel,
          mimeType: getAudioMime(file, outputExtension),
          name: file.name,
          objectUrl,
          size: file.size,
          virtualInputName,
        });
        setMode('equal');
        setEqualParts(2);
        setCustomCuts([]);
        setCurrentTime(0);
        setIsPlaying(false);
        setPlaybackRate(1);
        setZoom(60);
        setLoopRegion(null);
        setLoopDraft(null);
        setBookmarks([]);
        setCleanupPreset('none');
        setLastDetectionSummary('');
      });

      setOriginalAudioBackup((previousBackup) => {
        if (previousBackup?.objectUrl) {
          URL.revokeObjectURL(previousBackup.objectUrl);
        }
        return null;
      });

      setStatusText('File pronto. Scegli il tipo di taglio e scarica tutte le parti insieme.');
      setPhaseProgress(0);
      setTechnicalLog(technicalMessage);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Non sono riuscito ad analizzare il file.');
      setStatusText('Qualcosa è andato storto durante l’analisi del file.');
      setPhaseProgress(0);
    } finally {
      if (objectUrl && !keepObjectUrl) {
        URL.revokeObjectURL(objectUrl);
      }

      setIsBusy(false);
    }
  }

  async function handleInputChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && !isBusy) {
      await analyzeFile(file);
    }
  }

  function handleDragEnter(event) {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (!isBusy) {
      setDragActive(true);
    }
  }

  function handleDragLeave(event) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  }

  function handleDragOver(event) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = isBusy ? 'none' : 'copy';
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);

    if (isBusy) {
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (file) {
      await analyzeFile(file);
    }
  }

  const addCutAt = useCallback(
    (seconds) => {
      if (!audioFile?.duration) {
        return;
      }

      const safeSeconds = clamp(seconds, 0.25, Math.max(0.25, audioFile.duration - 0.25));
      setMode('custom');
      setCustomCuts((previous) => {
        const alreadyNear = previous.some(
          (point) =>
            typeof point.position === 'number' &&
            Math.abs(point.position - safeSeconds) < 0.1,
        );
        if (alreadyNear) {
          return previous;
        }
        return [
          ...previous,
          {
            id: createPointId(),
            value: formatClock(safeSeconds),
            position: safeSeconds,
          },
        ];
      });
    },
    [audioFile?.duration],
  );

  function updateCutPoint(id, value) {
    const parsed = parseTimeInput(value);
    setCustomCuts((previous) =>
      previous.map((point) => {
        if (point.id !== id) {
          return point;
        }
        return {
          ...point,
          value,
          position:
            parsed !== null && Number.isFinite(parsed) ? parsed : point.position,
        };
      }),
    );
  }

  const updateCutPointPosition = useCallback((id, position) => {
    if (!Number.isFinite(position)) {
      return;
    }
    setCustomCuts((previous) =>
      previous.map((point) =>
        point.id === id
          ? { ...point, value: formatClock(position), position }
          : point,
      ),
    );
  }, []);

  function removeCutPoint(id) {
    setCustomCuts((previous) => previous.filter((point) => point.id !== id));
  }

  const handleTogglePlay = useCallback(() => {
    waveformRef.current?.togglePlay();
  }, []);

  const handleSkip = useCallback((delta) => {
    waveformRef.current?.skip(delta);
  }, []);

  const RATE_STEPS = useMemo(() => [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3], []);

  const handleRateChange = useCallback((rate) => {
    if (typeof rate === 'number' && rate > 0) {
      setPlaybackRate(rate);
    }
  }, []);

  const handleSlowDown = useCallback(() => {
    setPlaybackRate((current) => {
      const index = RATE_STEPS.findIndex((rate) => Math.abs(rate - current) < 0.01);
      if (index > 0) {
        return RATE_STEPS[index - 1];
      }
      return RATE_STEPS[0];
    });
  }, [RATE_STEPS]);

  const handleSpeedUp = useCallback(() => {
    setPlaybackRate((current) => {
      const index = RATE_STEPS.findIndex((rate) => Math.abs(rate - current) < 0.01);
      if (index === -1) {
        return 1;
      }
      if (index < RATE_STEPS.length - 1) {
        return RATE_STEPS[index + 1];
      }
      return RATE_STEPS[RATE_STEPS.length - 1];
    });
  }, [RATE_STEPS]);

  const handleZoomChange = useCallback((value) => {
    setZoom(value);
  }, []);

  const getLivePosition = useCallback(() => {
    return waveformRef.current?.getCurrentTime?.() ?? currentTime;
  }, [currentTime]);

  const handleSetLoopStart = useCallback(() => {
    const position = getLivePosition();
    setLoopRegion(null);
    setLoopDraft(position);
  }, [getLivePosition]);

  const handleSetLoopEnd = useCallback(() => {
    const position = getLivePosition();
    if (loopDraft !== null && position > loopDraft + 0.2) {
      setLoopRegion({ start: loopDraft, end: position });
      setLoopDraft(null);
      return;
    }
    if (loopRegion && position > loopRegion.start + 0.2) {
      setLoopRegion({ start: loopRegion.start, end: position });
    }
  }, [getLivePosition, loopDraft, loopRegion]);

  const handleClearLoop = useCallback(() => {
    setLoopRegion(null);
    setLoopDraft(null);
  }, []);

  const handleAddCutHere = useCallback(() => {
    const position = getLivePosition();
    addCutAt(position);
  }, [addCutAt, getLivePosition]);

  const handleAddBookmarkHere = useCallback(() => {
    if (!audioFile?.duration) {
      return;
    }
    const position = clamp(getLivePosition(), 0, audioFile.duration);
    setBookmarks((previous) =>
      [
        ...previous,
        { id: createPointId(), position, note: '' },
      ].sort((left, right) => left.position - right.position),
    );
  }, [audioFile?.duration, getLivePosition]);

  const handleBookmarkJump = useCallback(
    (id) => {
      const bookmark = bookmarks.find((item) => item.id === id);
      if (bookmark) {
        waveformRef.current?.seekTo(bookmark.position);
      }
    },
    [bookmarks],
  );

  const handleBookmarkNoteChange = useCallback((id, note) => {
    setBookmarks((previous) =>
      previous.map((bookmark) =>
        bookmark.id === id ? { ...bookmark, note } : bookmark,
      ),
    );
  }, []);

  const handleBookmarkRemove = useCallback((id) => {
    setBookmarks((previous) => previous.filter((bookmark) => bookmark.id !== id));
  }, []);

  const handleWaveformReady = useCallback((duration) => {
    setPhaseProgress(0);
    if (Number.isFinite(duration) && duration > 0) {
      setAudioFile((previous) =>
        previous && Math.abs((previous.duration ?? 0) - duration) > 0.05
          ? { ...previous, duration }
          : previous,
      );
    }
  }, []);

  const handleWaveformTimeUpdate = useCallback((time) => {
    setCurrentTime(time);
  }, []);

  const handleWaveformPlayStateChange = useCallback((playing) => {
    setIsPlaying(playing);
  }, []);

  async function runWithLogCapture(ffmpeg, args) {
    const logs = [];
    const capture = ({ message }) => {
      if (typeof message === 'string') {
        logs.push(message);
      }
    };
    ffmpeg.on('log', capture);
    try {
      await ffmpeg.exec(args);
      return logs.join('\n');
    } finally {
      ffmpeg.off('log', capture);
    }
  }

  async function handleDetectSilences() {
    if (!audioFile || isBusy) {
      return;
    }

    setErrorText('');
    setIsBusy(true);
    setStatusText('Analisi dell’audio per trovare le pause lunghe...');
    setPhaseProgress(0.15);

    try {
      const ffmpeg = await ensureEngineReady();
      setPhaseProgress(0.4);

      const filter = buildSilenceDetectFilter({
        thresholdDb: silenceThresholdDb,
        minSilenceSeconds: silenceMinDuration,
      });

      const logText = await runWithLogCapture(ffmpeg, [
        '-hide_banner',
        '-nostats',
        '-i',
        audioFile.virtualInputName,
        '-af',
        filter,
        '-f',
        'null',
        '-',
      ]);

      const silences = parseSilenceLog(logText);
      const cutPositions = silencesToCutPoints({
        silences,
        duration: audioFile.duration,
        minSegmentLength: silenceMinSegment,
      });

      if (cutPositions.length === 0) {
        setLastDetectionSummary(
          `Nessun taglio utile con soglia ${silenceThresholdDb} dB e pausa ≥ ${silenceMinDuration}s. Prova ad abbassare la pausa o ad alzare la soglia.`,
        );
        setStatusText('Analisi completata: nessuna pausa adatta.');
        setPhaseProgress(0);
        return;
      }

      setMode('custom');
      setCustomCuts(
        cutPositions.map((position) => ({
          id: createPointId(),
          value: formatClock(position),
          position,
        })),
      );

      setLastDetectionSummary(
        `${cutPositions.length} taglio${cutPositions.length === 1 ? '' : 'i'} auto da ${silences.length} pause rilevate.`,
      );
      setStatusText(
        `Rilevati ${silences.length} silenzi; suggeriti ${cutPositions.length} punti di taglio.`,
      );
      setTechnicalLog(
        `silencedetect: threshold=${silenceThresholdDb}dB, min=${silenceMinDuration}s → ${silences.length} gap.`,
      );
      setPhaseProgress(1);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Non sono riuscito ad analizzare i silenzi.');
      setStatusText('Analisi dei silenzi non completata.');
      setPhaseProgress(0);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleApplyCleanup() {
    if (!audioFile || isBusy) {
      return;
    }
    const preset = getCleanupPreset(cleanupPreset);
    if (!preset || preset.filters.length === 0) {
      return;
    }

    setErrorText('');
    setIsBusy(true);
    setStatusText(`Applico il preset "${preset.label}"...`);
    setPhaseProgress(0.1);

    const cleanedVirtualName = `cleaned-${Date.now()}.m4a`;
    let ffmpeg = null;

    try {
      ffmpeg = await ensureEngineReady();
      setPhaseProgress(0.3);

      const filterChain = buildCleanupFilter(cleanupPreset);
      await ffmpeg.exec([
        '-hide_banner',
        '-nostats',
        '-i',
        audioFile.virtualInputName,
        '-af',
        filterChain,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        cleanedVirtualName,
      ]);
      setPhaseProgress(0.7);

      const cleanedData = await ffmpeg.readFile(cleanedVirtualName);
      const cleanedBlob = new Blob([cleanedData], { type: 'audio/mp4' });
      const newObjectUrl = URL.createObjectURL(cleanedBlob);

      const probedDuration = await readAudioDurationFromBrowser(newObjectUrl);
      const newDuration =
        typeof probedDuration === 'number' && Number.isFinite(probedDuration) && probedDuration > 0
          ? probedDuration
          : audioFile.duration;

      setOriginalAudioBackup((previousBackup) => {
        if (previousBackup) {
          return previousBackup;
        }
        return {
          objectUrl: audioFile.objectUrl,
          virtualInputName: audioFile.virtualInputName,
          extension: audioFile.extension,
          duration: audioFile.duration,
          formatLabel: audioFile.formatLabel,
          mimeType: audioFile.mimeType,
          size: audioFile.size,
          baseName: audioFile.baseName,
          name: audioFile.name,
        };
      });

      if (!originalAudioBackup && objectUrlRef.current === audioFile.objectUrl) {
        // Keep the old objectUrl alive (it is tracked inside the backup)
      } else if (audioFile.objectUrl && audioFile.objectUrl !== originalAudioBackup?.objectUrl) {
        URL.revokeObjectURL(audioFile.objectUrl);
      }
      objectUrlRef.current = newObjectUrl;

      if (!originalAudioBackup) {
        // Do not delete the original file from ffmpeg FS; keep it so we can restore.
      } else if (audioFile.virtualInputName !== originalAudioBackup.virtualInputName) {
        await safeDelete(ffmpeg, audioFile.virtualInputName);
      }

      setAudioFile((previous) =>
        previous
          ? {
              ...previous,
              objectUrl: newObjectUrl,
              virtualInputName: cleanedVirtualName,
              extension: 'm4a',
              duration: newDuration,
              formatLabel: `${preset.label} · AAC 128k`,
              mimeType: 'audio/mp4',
              size: cleanedBlob.size,
            }
          : previous,
      );

      activeInputRef.current = cleanedVirtualName;
      setCustomCuts([]);
      setBookmarks([]);
      setLoopRegion(null);
      setLoopDraft(null);
      setCurrentTime(0);
      setIsPlaying(false);
      setLastDetectionSummary('');
      setStatusText(`Pulizia applicata (${preset.label}). Il file è pronto per il taglio.`);
      setTechnicalLog(`cleanup: ${preset.filters.join(' → ')}`);
      setPhaseProgress(1);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Pulizia dell’audio non completata.');
      setStatusText('Pulizia non completata.');
      setPhaseProgress(0);
      if (ffmpeg) {
        await safeDelete(ffmpeg, cleanedVirtualName);
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRestoreOriginal() {
    if (!originalAudioBackup || isBusy) {
      return;
    }

    setErrorText('');
    setIsBusy(true);
    setStatusText('Ripristino la versione originale del file...');

    try {
      const currentVirtual = audioFile?.virtualInputName;
      if (audioFile?.objectUrl && audioFile.objectUrl !== originalAudioBackup.objectUrl) {
        URL.revokeObjectURL(audioFile.objectUrl);
      }
      if (ffmpegRef.current && currentVirtual && currentVirtual !== originalAudioBackup.virtualInputName) {
        await safeDelete(ffmpegRef.current, currentVirtual);
      }

      objectUrlRef.current = originalAudioBackup.objectUrl;
      activeInputRef.current = originalAudioBackup.virtualInputName;

      setAudioFile((previous) =>
        previous
          ? {
              ...previous,
              objectUrl: originalAudioBackup.objectUrl,
              virtualInputName: originalAudioBackup.virtualInputName,
              extension: originalAudioBackup.extension,
              duration: originalAudioBackup.duration,
              formatLabel: originalAudioBackup.formatLabel,
              mimeType: originalAudioBackup.mimeType,
              size: originalAudioBackup.size,
              baseName: originalAudioBackup.baseName ?? previous.baseName,
              name: originalAudioBackup.name ?? previous.name,
            }
          : previous,
      );
      setCustomCuts([]);
      setBookmarks([]);
      setLoopRegion(null);
      setLoopDraft(null);
      setCurrentTime(0);
      setIsPlaying(false);
      setCleanupPreset('none');
      setLastDetectionSummary('');
      setOriginalAudioBackup(null);
      setStatusText('Versione originale ripristinata.');
      setTechnicalLog('cleanup: ripristino originale completato.');
      setPhaseProgress(0);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Ripristino non riuscito.');
      setStatusText('Ripristino non completato.');
    } finally {
      setIsBusy(false);
    }
  }

  useKeyboardShortcuts(
    {
      togglePlay: handleTogglePlay,
      skipBack5: () => handleSkip(-5),
      skipForward5: () => handleSkip(5),
      skipBack30: () => handleSkip(-30),
      skipForward30: () => handleSkip(30),
      slowDown: handleSlowDown,
      speedUp: handleSpeedUp,
      addCutHere: handleAddCutHere,
      addBookmarkHere: handleAddBookmarkHere,
      setLoopStart: handleSetLoopStart,
      setLoopEnd: handleSetLoopEnd,
      clearLoop: handleClearLoop,
    },
    { enabled: Boolean(audioFile) && !isBusy },
  );

  async function processAndDownload() {
    if (!audioFile || plan.error || plan.segments.length < 2) {
      setErrorText(plan.error || 'Definisci almeno due parti prima di esportare.');
      return;
    }

    setErrorText('');
    setLastResult(null);
    setIsBusy(true);
    setPhaseProgress(0.05);
    setStatusText('Sto tagliando il file e preparando lo ZIP...');

    const runPrefix = `segment-${Date.now()}`;
    let ffmpeg = null;
    const createdVirtualNames = [];
    let exportMode = 'multi-copy';
    let outputExtension = audioFile.extension;

    try {
      ffmpeg = await ensureEngineReady();
      const segmentTimes = plan.cutPoints.map((value) => value.toFixed(3)).join(',');
      const outputPattern = `${runPrefix}-%03d${outputExtension}`;

      async function cleanupExports() {
        for (const virtualName of createdVirtualNames) {
          await safeDelete(ffmpeg, virtualName);
        }

        createdVirtualNames.length = 0;
      }

      const batchExitCode = await ffmpeg.exec([
        '-i',
        audioFile.virtualInputName,
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_times',
        segmentTimes,
        '-reset_timestamps',
        '1',
        outputPattern,
      ]);

      if (batchExitCode === 0) {
        for (let index = 0; index < plan.segments.length; index += 1) {
          createdVirtualNames.push(buildVirtualSegmentName(runPrefix, index, outputExtension));
        }
      } else {
        exportMode = 'single-copy';
        setTechnicalLog(
          'Il taglio multiplo in blocco non è supportato da questo contenitore. Passo al taglio diretto parte per parte.',
        );
        setStatusText('Questo formato richiede un taglio diretto parte per parte. Continuo automaticamente...');
        setPhaseProgress(0.18);

        for (let index = 0; index < plan.segments.length; index += 1) {
          await safeDelete(ffmpeg, buildVirtualSegmentName(runPrefix, index, outputExtension));
        }

        for (let index = 0; index < plan.segments.length; index += 1) {
          const segment = plan.segments[index];
          const virtualName = buildVirtualSegmentName(runPrefix, index, outputExtension);
          const segmentExitCode = await ffmpeg.exec([
            '-ss',
            formatFfmpegTime(segment.start),
            '-t',
            formatFfmpegTime(segment.duration),
            '-i',
            audioFile.virtualInputName,
            '-map',
            '0',
            '-c',
            'copy',
            '-reset_timestamps',
            '1',
            '-avoid_negative_ts',
            'make_zero',
            virtualName,
          ]);

          if (segmentExitCode !== 0) {
            await cleanupExports();
            exportMode = 'lossy-aac';
            outputExtension = '.m4a';
            setTechnicalLog(
              'La copia diretta non è riuscita. Passo a un export AAC in M4A per completare il taglio con file più leggeri.',
            );
            setStatusText('Questo file richiede una nuova codifica AAC in M4A. Continuo automaticamente...');
            setPhaseProgress(0.32);

            for (let fallbackIndex = 0; fallbackIndex < plan.segments.length; fallbackIndex += 1) {
              const fallbackSegment = plan.segments[fallbackIndex];
              const fallbackName = buildVirtualSegmentName(runPrefix, fallbackIndex, outputExtension);
              const fallbackExitCode = await ffmpeg.exec([
                '-ss',
                formatFfmpegTime(fallbackSegment.start),
                '-t',
                formatFfmpegTime(fallbackSegment.duration),
                '-i',
                audioFile.virtualInputName,
                '-map',
                '0:a:0',
                '-c:a',
                'aac',
                '-b:a',
                '160k',
                fallbackName,
              ]);

              if (fallbackExitCode !== 0) {
                await cleanupExports();
                exportMode = 'lossless-flac';
                outputExtension = '.flac';
                setTechnicalLog(
                  'Il fallback AAC non è riuscito. Passo a un export FLAC lossless come ultima opzione.',
                );
                setStatusText('Il file richiede un export FLAC lossless come ultima opzione...');
                setPhaseProgress(0.45);

                for (
                  let losslessIndex = 0;
                  losslessIndex < plan.segments.length;
                  losslessIndex += 1
                ) {
                  const losslessSegment = plan.segments[losslessIndex];
                  const losslessName = buildVirtualSegmentName(
                    runPrefix,
                    losslessIndex,
                    outputExtension,
                  );
                  const losslessExitCode = await ffmpeg.exec([
                    '-ss',
                    formatFfmpegTime(losslessSegment.start),
                    '-t',
                    formatFfmpegTime(losslessSegment.duration),
                    '-i',
                    audioFile.virtualInputName,
                    '-map',
                    '0:a:0',
                    '-c:a',
                    'flac',
                    losslessName,
                  ]);

                  if (losslessExitCode !== 0) {
                    throw new Error(
                      'Non sono riuscito a tagliare questo file nel browser neanche con il fallback finale.',
                    );
                  }

                  createdVirtualNames.push(losslessName);
                  setStatusText(
                    `Preparo parte ${losslessIndex + 1} di ${plan.segments.length} in FLAC lossless...`,
                  );
                  setPhaseProgress(0.45 + ((losslessIndex + 1) / plan.segments.length) * 0.25);
                }

                break;
              }

              createdVirtualNames.push(fallbackName);
              setStatusText(
                `Preparo parte ${fallbackIndex + 1} di ${plan.segments.length} in AAC M4A...`,
              );
              setPhaseProgress(0.32 + ((fallbackIndex + 1) / plan.segments.length) * 0.38);
            }

            break;
          }

          createdVirtualNames.push(virtualName);
          setStatusText(
            `Preparo parte ${index + 1} di ${plan.segments.length} senza ricodifica...`,
          );
          setPhaseProgress(0.18 + ((index + 1) / plan.segments.length) * 0.52);
        }
      }

      setStatusText('Creo l’archivio ZIP finale con tutte le parti rinominate...');
      setPhaseProgress(0.78);

      const zip = new JSZip();
      const exportedParts = [];

      for (let index = 0; index < plan.segments.length; index += 1) {
        const virtualName = createdVirtualNames[index];
        const outputData = await ffmpeg.readFile(virtualName);
        const downloadName = buildDownloadName(audioFile.baseName, index + 1, outputExtension);

        zip.file(downloadName, outputData, { binary: true });
        exportedParts.push({
          name: downloadName,
          size: outputData.byteLength,
          duration: plan.segments[index].duration,
        });
      }

      const archiveName = `${audioFile.baseName} - parti.zip`;
      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'STORE',
        },
        ({ percent }) => {
          setPhaseProgress(0.78 + percent / 100 * 0.22);
        },
      );

      downloadBlob(zipBlob, archiveName);

      setLastResult({
        archiveName,
        parts: exportedParts,
      });
      setStatusText('Fatto. Ho scaricato tutte le parti in un solo ZIP, già rinominate.');
      setTechnicalLog(
        exportMode === 'multi-copy'
          ? `Esportazione completata in copia diretta: ${exportedParts.length} file pronti.`
          : exportMode === 'single-copy'
            ? `Esportazione completata con fallback parte per parte: ${exportedParts.length} file pronti.`
            : exportMode === 'lossy-aac'
              ? `Esportazione completata con fallback AAC M4A: ${exportedParts.length} file pronti.`
              : `Esportazione completata con fallback FLAC lossless: ${exportedParts.length} file pronti.`,
      );
      setPhaseProgress(1);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Non sono riuscito a esportare le parti.');
      setStatusText('Esportazione non completata.');
      setPhaseProgress(0);
    } finally {
      if (ffmpeg) {
        for (const virtualName of createdVirtualNames) {
          await safeDelete(ffmpeg, virtualName);
        }
      }

      setIsBusy(false);
    }
  }

  const canExport = Boolean(audioFile) && !plan.error && plan.segments.length >= 2 && !isBusy;
  const helperChips = [
    'Locale nel browser',
    'Un solo upload',
    'Copia diretta senza ricodifica',
  ];

  return (
    <div className="shell">
      <div className="aurora aurora-left" />
      <div className="aurora aurora-right" />

      <header className="topbar">
        <div>
          <p className="eyebrow">Audio cutter pensato per GitHub Pages</p>
          <h1>
            Taglia una volta,
            <span> scarica tutto subito.</span>
          </h1>
        </div>
        <p className="lead">
          Carichi un audio una sola volta, scegli il taglio e scarichi tutte le parti
          già rinominate come <strong>parte 1</strong>, <strong>parte 2</strong>,
          <strong>parte 3</strong>.
        </p>
      </header>

      <main className="workspace">
        <section className="stage">
          <div className="stage-header">
            <div className="pill-group">
              {helperChips.map((chip) => (
                <span className="pill" key={chip}>
                  {chip}
                </span>
              ))}
            </div>

            <button
              className="ghost-button"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={isBusy}
            >
              Scegli un file
            </button>
          </div>

          <label
            className={`dropzone ${dragActive ? 'dropzone-active' : ''} ${isBusy ? 'dropzone-busy' : ''}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_AUDIO_TYPES}
              onChange={handleInputChange}
              disabled={isBusy}
              hidden
            />
            <span className="dropzone-kicker">Drag & drop oppure click</span>
            <strong>Carica un file audio</strong>
            <p>
              Supporto pensato per i formati più comuni. Il file resta locale e non viene
              caricato su server esterni.
            </p>
          </label>

          <div className="status-strip">
            <div>
              <span className={`status-dot status-${engineState}`} />
              <strong>{engineState === 'ready' ? 'Motore pronto' : 'Motore locale'}</strong>
            </div>
            <p>{statusText}</p>
          </div>

          <div className="progress-track" aria-hidden="true">
            <span
              className={`progress-bar ${isBusy ? 'progress-bar-busy' : ''}`}
              style={{ transform: `scaleX(${phaseProgress || 0.02})` }}
            />
          </div>

          {audioFile ? (
            <div className="studio">
              <div className="studio-head">
                <div>
                  <p className="section-label">File caricato</p>
                  <h2>{audioFile.name}</h2>
                  <div className="meta-row">
                    <span>{formatClock(audioFile.duration)}</span>
                    <span>{formatBytes(audioFile.size)}</span>
                    <span>{audioFile.formatLabel}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setShowShortcuts((value) => !value)}
                  title="Mostra scorciatoie da tastiera"
                >
                  {showShortcuts ? 'Chiudi scorciatoie' : 'Scorciatoie tastiera'}
                </button>
              </div>

              <WaveformEditor
                ref={waveformRef}
                src={audioFile.objectUrl}
                cuts={customCuts}
                bookmarks={bookmarks}
                loopRegion={loopRegion}
                playbackRate={playbackRate}
                zoom={zoom}
                onReady={handleWaveformReady}
                onTimeUpdate={handleWaveformTimeUpdate}
                onPlayStateChange={handleWaveformPlayStateChange}
                onCutMove={updateCutPointPosition}
              />

              <PlayerControls
                isPlaying={isPlaying}
                currentTime={currentTime}
                duration={audioFile.duration}
                playbackRate={playbackRate}
                zoom={zoom}
                loopRegion={loopRegion}
                loopDraft={loopDraft}
                onTogglePlay={handleTogglePlay}
                onSkip={handleSkip}
                onRateChange={handleRateChange}
                onZoomChange={handleZoomChange}
                onSetLoopStart={handleSetLoopStart}
                onSetLoopEnd={handleSetLoopEnd}
                onClearLoop={handleClearLoop}
                onAddCutHere={handleAddCutHere}
                onAddBookmarkHere={handleAddBookmarkHere}
                disabled={isBusy}
              />

              {showShortcuts ? (
                <div className="shortcuts-panel">
                  <p className="section-label">Scorciatoie da tastiera</p>
                  <ul className="shortcuts-list">
                    {KEYBOARD_HINTS.map((hint) => (
                      <li key={hint.action}>
                        <span className="shortcut-keys">
                          {hint.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                        </span>
                        <span className="shortcut-action">{hint.action}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <BookmarksPanel
                bookmarks={bookmarks}
                onJump={handleBookmarkJump}
                onRemove={handleBookmarkRemove}
                onNoteChange={handleBookmarkNoteChange}
                disabled={isBusy}
              />
            </div>
          ) : null}

          {audioFile ? (
            <AutomationPanel
              silenceThresholdDb={silenceThresholdDb}
              silenceMinDuration={silenceMinDuration}
              silenceMinSegment={silenceMinSegment}
              onSilenceThresholdChange={setSilenceThresholdDb}
              onSilenceDurationChange={setSilenceMinDuration}
              onSilenceMinSegmentChange={setSilenceMinSegment}
              onDetectSilences={handleDetectSilences}
              cleanupPreset={cleanupPreset}
              onCleanupPresetChange={setCleanupPreset}
              onApplyCleanup={handleApplyCleanup}
              onRestoreOriginal={handleRestoreOriginal}
              hasOriginalBackup={Boolean(originalAudioBackup)}
              hasCleanedAudio={Boolean(originalAudioBackup)}
              disabled={isBusy}
              lastDetectionSummary={lastDetectionSummary}
            />
          ) : null}

          <div className="editor-grid">
            <div className="editor-column">
              <div className="mode-switch">
                <button
                  type="button"
                  className={mode === 'equal' ? 'mode-active' : ''}
                  onClick={() => setMode('equal')}
                >
                  Parti uguali
                </button>
                <button
                  type="button"
                  className={mode === 'custom' ? 'mode-active' : ''}
                  onClick={() => setMode('custom')}
                >
                  Punti personalizzati
                </button>
              </div>

              {mode === 'equal' ? (
                <div className="control-panel">
                  <div className="quick-presets">
                    {[2, 3, 4].map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={equalParts === value ? 'preset-active' : ''}
                        onClick={() => setEqualParts(value)}
                      >
                        {value} parti
                      </button>
                    ))}
                  </div>

                  <label className="field">
                    <span>Numero di parti uguali</span>
                    <input
                      type="range"
                      min="2"
                      max="12"
                      value={equalParts}
                      onChange={(event) => setEqualParts(Number(event.target.value))}
                    />
                    <strong>{equalParts} parti</strong>
                  </label>
                </div>
              ) : (
                <div className="control-panel">
                  <div className="custom-actions">
                    <button type="button" onClick={() => addCutAt(currentTime)}>
                      Usa la posizione corrente
                    </button>
                    <button
                      type="button"
                      onClick={() => addCutAt((audioFile?.duration ?? 0) / 2)}
                    >
                      Inserisci un taglio a metà
                    </button>
                  </div>

                  <p className="helper-text">
                    Puoi scrivere i punti in secondi oppure in formato <code>mm:ss</code>{' '}
                    o <code>hh:mm:ss</code>.
                  </p>

                  <div className="cut-list">
                    {customCuts.length === 0 ? (
                      <p className="empty-text">
                        Nessun punto inserito. Premi un pulsante sopra oppure aggiungi un
                        tempo manuale.
                      </p>
                    ) : null}

                    {customCuts.map((point) => {
                      const sliderValue = clamp(
                        typeof point.position === 'number' && Number.isFinite(point.position)
                          ? point.position
                          : parseTimeInput(point.value) ?? 0,
                        0,
                        audioFile?.duration ?? 0,
                      );
                      return (
                        <div className="cut-row" key={point.id}>
                          <input
                            type="text"
                            value={point.value}
                            onChange={(event) => updateCutPoint(point.id, event.target.value)}
                            placeholder="00:30"
                          />
                          <input
                            type="range"
                            min="0"
                            max={audioFile?.duration ?? 0}
                            step="0.1"
                            value={sliderValue}
                            onChange={(event) =>
                              updateCutPointPosition(point.id, Number(event.target.value))
                            }
                          />
                          <button type="button" onClick={() => removeCutPoint(point.id)}>
                            Rimuovi
                          </button>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      className="add-manual"
                      onClick={() =>
                        setCustomCuts((previous) => [
                          ...previous,
                          { id: createPointId(), value: '', position: null },
                        ])
                      }
                    >
                      Aggiungi un punto manuale
                    </button>
                  </div>
                </div>
              )}
            </div>

            <aside className="summary-column">
              <div className="summary-head">
                <p className="section-label">Anteprima esportazione</p>
                <strong>
                  {plan.segments.length > 0 ? `${plan.segments.length} file pronti` : 'In attesa'}
                </strong>
              </div>

              {plan.error ? <p className="error-text">{plan.error}</p> : null}
              {errorText ? <p className="error-text">{errorText}</p> : null}

              {plan.segments.length > 0 ? (
                <div className="segment-stack">
                  {plan.segments.map((segment) => (
                    <div className="segment-row" key={segment.index}>
                      <div>
                        <strong>
                          {buildDownloadName(
                            audioFile?.baseName ?? 'audio',
                            segment.index,
                            audioFile?.extension ?? '',
                          )}
                        </strong>
                        <p>{segment.rangeLabel}</p>
                      </div>
                      <span>{formatClock(segment.duration)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="empty-text">Le parti appariranno qui appena il piano è valido.</p>
              )}

              <button
                type="button"
                className="primary-button"
                onClick={processAndDownload}
                disabled={!canExport}
              >
                {isBusy ? 'Elaborazione in corso...' : 'Taglia e scarica tutto'}
              </button>

              <p className="helper-text">
                Il download genera uno ZIP senza comprimere di nuovo l’audio, per restare più
                rapido possibile.
              </p>
            </aside>
          </div>
        </section>

        <section className="details">
          <div className="detail">
            <p className="section-label">Perché è più veloce</p>
            <strong>Un solo file in ingresso, tutte le parti in uscita.</strong>
            <p>
              Il sito analizza il file una volta sola, applica tutti i punti di taglio in un
              unico passaggio e prepara subito l’archivio finale.
            </p>
          </div>

          <div className="detail">
            <p className="section-label">Qualità</p>
            <strong>Nessuna ricodifica quando il formato lo consente.</strong>
            <p>
              La strategia predefinita usa copia diretta dei flussi audio per evitare perdite
              di qualità e tempi morti di esportazione.
            </p>
          </div>

          <div className="detail">
            <p className="section-label">Stato tecnico</p>
            <strong>{technicalLog || 'In attesa del prossimo passaggio.'}</strong>
            <p>
              {lastResult
                ? `Ultimo ZIP creato: ${lastResult.archiveName}`
                : 'Qui comparirà l’ultimo messaggio utile del motore di elaborazione.'}
            </p>
          </div>
        </section>

        {lastResult ? (
          <section className="result-banner">
            <p className="section-label">Ultima esportazione</p>
            <h3>{lastResult.archiveName}</h3>
            <div className="result-list">
              {lastResult.parts.map((part) => (
                <span key={part.name}>
                  {part.name} · {formatBytes(part.size)} · {formatClock(part.duration)}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
