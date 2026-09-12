import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchFile } from '@ffmpeg/util';
import {
  buildPlan,
  buildVirtualSegmentName,
} from './lib/segments.js';
import {
  buildExportArgs,
  buildSegmentFileName,
  canFastCopy,
  estimateExportBytes,
  getExportFormat,
  sanitizeFileName,
} from './lib/export.js';
import {
  RETAIN_BLOBS_BYTES,
  adviseExportStrategy,
  clearCheckpoint,
  createZipBlobWriter,
  createZipStreamWriter,
  getExportCapabilities,
  readCheckpoint,
  writeBlobToFileHandle,
  writeCheckpoint,
  yieldToUI,
} from './lib/streamExport.js';
import { useWakeLock } from './hooks/useWakeLock.js';
import {
  clamp,
  formatBytes,
  formatClock,
  getExtension,
  parseTimeInput,
  stripExtension,
} from './lib/time.js';
import { WaveformEditor } from './components/WaveformEditor.jsx';
import { PlayerControls, RATE_PRESETS } from './components/PlayerControls.jsx';
import { BookmarksPanel } from './components/BookmarksPanel.jsx';
import { AutomationPanel } from './components/AutomationPanel.jsx';
import { ExportPanel } from './components/ExportPanel.jsx';
import { Recorder } from './components/Recorder.jsx';
import { ProjectLibrary } from './components/ProjectLibrary.jsx';
import { useFfmpegEngine, safeDelete } from './hooks/useFfmpegEngine.js';
import {
  KEYBOARD_HINTS,
  useKeyboardShortcuts,
} from './hooks/useKeyboardShortcuts.js';
import {
  buildSilenceDetectFilter,
  parseSilenceLog,
  silencesToCutPoints,
} from './lib/silence.js';
import {
  buildCleanupFilter,
  estimateCleanupSeconds,
  getCleanupPreset,
} from './lib/cleanup.js';
import {
  deleteProject as deleteStoredProject,
  listProjects,
  loadProject as loadStoredProject,
  saveProject as saveStoredProject,
} from './lib/storage.js';

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

function loadSetting(key, fallback) {
  try {
    const raw = window.localStorage?.getItem(key);
    if (raw === null || raw === undefined) {
      return fallback;
    }
    if (typeof fallback === 'boolean') {
      return raw === '1' || raw === 'true';
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    const stored = typeof value === 'boolean' ? (value ? '1' : '0') : JSON.stringify(value);
    window.localStorage?.setItem(key, stored);
  } catch {
    // storage pieno o non disponibile: impostazioni solo per la sessione
  }
}

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

export default function App() {
  const inputRef = useRef(null);
  const objectUrlRef = useRef('');
  const activeInputRef = useRef('');
  const activeProbeRef = useRef('');
  const dragDepthRef = useRef(0);
  const waveformRef = useRef(null);
  const exportAbortRef = useRef(false);
  const previewTimeoutRef = useRef(null);
  const lastResultUrlsRef = useRef([]);
  const analysisIdRef = useRef(0);
  const isBusyRef = useRef(false);
  const isRecorderBusyRef = useRef(false);
  const sourceFileRef = useRef(null);

  const {
    ffmpegRef,
    engineState,
    setEngineState,
    phaseProgress,
    setPhaseProgress,
    technicalLog,
    setTechnicalLog,
    ensureReady: ensureEngineReadyBase,
    runWithLogCapture,
    resetAfterAbort,
  } = useFfmpegEngine();

  async function ensureEngineReady(options) {
    const silent = options?.silent ?? false;
    if (!silent) {
      setStatusText('Carico il motore locale di taglio. Succede solo la prima volta.');
      setPhaseProgress(0.08);
    }
    try {
      const ffmpeg = await ensureEngineReadyBase(options);
      if (!silent) {
        setStatusText('Motore pronto. Ora puoi analizzare e tagliare il file.');
        setPhaseProgress(0);
      }
      return ffmpeg;
    } catch (error) {
      setEngineState('idle');
      throw error;
    }
  }

  const [statusText, setStatusText] = useState(INITIAL_MESSAGE);
  const [dragActive, setDragActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [mode, setMode] = useState('equal');
  const [equalParts, setEqualParts] = useState(2);
  const [customCuts, setCustomCuts] = useState([]);
  const [cutsHistory, setCutsHistory] = useState([]);
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
  const [activeCapture, setActiveCapture] = useState('none');
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [isRecorderBusy, setIsRecorderBusy] = useState(false);
  const [exportFormat, setExportFormat] = useState(() => loadSetting('ac-export-format', 'm4a'));
  const [exportBitrate, setExportBitrate] = useState(() => Number(loadSetting('ac-export-bitrate', 128)) || 128);
  const [fastCopy, setFastCopy] = useState(() => loadSetting('ac-fast-copy', false));
  const [fadeSeconds, setFadeSeconds] = useState(() => Number(loadSetting('ac-fade', 0)) || 0);
  const [exportDest, setExportDest] = useState(() => loadSetting('ac-export-dest', 'auto'));
  const [skipExisting, setSkipExisting] = useState(true);
  const [advisorNote, setAdvisorNote] = useState('');
  const [resumeNotice, setResumeNotice] = useState('');
  const [baseNameOverride, setBaseNameOverride] = useState('');
  const [segmentNames, setSegmentNames] = useState({});
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  const [previewIndex, setPreviewIndex] = useState(null);
  const [failedExportIndex, setFailedExportIndex] = useState(null);
  const [chaptersStatus, setChaptersStatus] = useState('');
  const [timestampDraft, setTimestampDraft] = useState('');
  const [projectJsonStatus, setProjectJsonStatus] = useState('');

  const plan = buildPlan({
    duration: audioFile?.duration ?? 0,
    mode,
    equalParts,
    customCuts,
  });

  const backupUrlRef = useRef(null);
  backupUrlRef.current = originalAudioBackup?.objectUrl ?? null;

  const effectiveBaseName = baseNameOverride.trim() || audioFile?.baseName || 'audio';

  const waveformCuts = useMemo(() => {
    if (mode === 'custom') {
      return customCuts;
    }
    return (plan.cutPoints ?? []).map((position, index) => ({
      id: `equal-${index}`,
      value: formatClock(position),
      position,
    }));
  }, [mode, customCuts, plan.cutPoints]);

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

      for (const url of lastResultUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      lastResultUrlsRef.current = [];

      if (previewTimeoutRef.current) {
        window.clearTimeout(previewTimeoutRef.current);
      }

      activeInputRef.current = '';
      activeProbeRef.current = '';
    };
  }, []);

  async function analyzeFile(file) {
    if (!file) {
      return false;
    }
    if (isBusyRef.current) {
      setErrorText('Attendi il completamento dell’operazione in corso prima di caricare un altro file.');
      return false;
    }
    if (isRecorderBusyRef.current) {
      setErrorText('Ferma la registrazione prima di caricare un altro file.');
      return false;
    }
    if (file.size === 0) {
      setErrorText('Il file è vuoto (0 byte). Scegli un file audio valido.');
      return false;
    }

    const analysisId = analysisIdRef.current + 1;
    analysisIdRef.current = analysisId;
    const isStale = () => analysisIdRef.current !== analysisId;

    let objectUrl = '';
    let keepObjectUrl = false;

    setErrorText('');
    setLastResult(null);
    isBusyRef.current = true;
    setIsBusy(true);
    setStatusText('Analizzo il file e recupero la durata esatta...');
    setPhaseProgress(0.12);

    try {
      const extension = getExtension(file.name);
      const outputExtension = extension || '.audio';
      const baseName = stripExtension(file.name);
      const virtualInputName = `source-${Date.now()}-${analysisId}${outputExtension}`;
      const probeOutputName = `probe-${Date.now()}-${analysisId}.json`;
      let duration = NaN;
      let technicalMessage = 'File pronto.';
      let formatLabel = getFormatLabel(file, outputExtension);

      if (file.size > 350 * 1024 * 1024) {
        technicalMessage = 'File molto grande: l’analisi potrebbe richiedere tempo e memoria.';
        setStatusText('File molto grande (>350 MB): analisi in corso, potrebbe volerci un po’...');
      }

      objectUrl = URL.createObjectURL(file);

      try {
        duration = await readAudioDurationFromBrowser(objectUrl);
        if (isStale()) {
          URL.revokeObjectURL(objectUrl);
          return false;
        }
        technicalMessage = 'Durata recuperata direttamente dal browser.';
      } catch {
        if (isStale()) {
          URL.revokeObjectURL(objectUrl);
          return false;
        }
        technicalMessage = 'Il browser non legge la durata, provo con ffprobe.';
      }

      const ffmpeg = await ensureEngineReady();
      if (isStale()) {
        return false;
      }

      const staleVirtualNames = new Set(
        [
          activeInputRef.current,
          activeProbeRef.current,
          originalAudioBackup?.virtualInputName,
        ].filter(Boolean),
      );
      for (const virtualName of staleVirtualNames) {
        await safeDelete(ffmpeg, virtualName);
      }
      activeInputRef.current = '';
      activeProbeRef.current = '';

      await ffmpeg.writeFile(virtualInputName, await fetchFile(file));
      if (isStale()) {
        await safeDelete(ffmpeg, virtualInputName);
        return false;
      }
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
        await safeDelete(ffmpeg, probeOutputName);
        activeProbeRef.current = '';
        duration = Number(String(probeRaw).trim());
        technicalMessage = 'Durata recuperata con ffprobe.';
      }

      if (isStale()) {
        return false;
      }

      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Durata non valida. Prova con un file audio differente.');
      }

      // Verifica che esista davvero una traccia audio (evita video/mascherati accettati per durata).
      try {
        const streamProbeName = `streams-${Date.now()}-${analysisId}.txt`;
        activeProbeRef.current = streamProbeName;
        const streamExit = await ffmpeg.ffprobe([
          '-v', 'error',
          '-show_entries', 'stream=codec_type',
          '-of', 'csv=p=0',
          virtualInputName,
          '-o', streamProbeName,
        ]);
        const streamRaw = streamExit === 0 ? await ffmpeg.readFile(streamProbeName, 'utf8') : '';
        await safeDelete(ffmpeg, streamProbeName);
        activeProbeRef.current = '';
        if (isStale()) {
          return false;
        }
        if (!String(streamRaw).toLowerCase().includes('audio')) {
          throw new Error('Nessuna traccia audio trovata in questo file. Scegli un file audio valido.');
        }
      } catch (probeError) {
        if (probeError?.message?.includes('Nessuna traccia audio')) {
          throw probeError;
        }
        // Probe stream non disponibile: prosegui (l'export segnalerà l'errore reale).
      }

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = objectUrl;
      keepObjectUrl = true;

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
      // Riferimento al File originale: evita una copia in RAM al salvataggio progetto.
      sourceFileRef.current = file instanceof File ? file : null;
      setMode('equal');
      setEqualParts(2);
      setCustomCuts([]);
      setCutsHistory([]);
      setCurrentTime(0);
      setIsPlaying(false);
      setPlaybackRate(1);
      setZoom(60);
      setLoopRegion(null);
      setLoopDraft(null);
      setBookmarks([]);
      setCleanupPreset('none');
      setLastDetectionSummary('');
      setBaseNameOverride('');
      setSegmentNames({});
      setPreviewIndex(null);
      setExportFormat('m4a');
      setExportBitrate(128);
      setFastCopy(false);
      setFadeSeconds(0);
      setIsExporting(false);
      setExportProgress(0);
      for (const url of lastResultUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      lastResultUrlsRef.current = [];

      setOriginalAudioBackup((previousBackup) => {
        if (previousBackup?.objectUrl) {
          URL.revokeObjectURL(previousBackup.objectUrl);
        }
        return null;
      });

      setStatusText('File pronto. Scegli il tipo di taglio e scarica tutte le parti insieme.');
      setPhaseProgress(0);
      setTechnicalLog(technicalMessage);
      clearPreview();
      return true;
    } catch (error) {
      console.error(error);
      if (analysisIdRef.current !== analysisId) {
        return false;
      }
      setErrorText(error.message || 'Non sono riuscito ad analizzare il file.');
      setStatusText('Qualcosa è andato storto durante l’analisi del file.');
      setPhaseProgress(0);
      return false;
    } finally {
      if (objectUrl && !keepObjectUrl) {
        URL.revokeObjectURL(objectUrl);
      }

      if (analysisIdRef.current === analysisId) {
        isBusyRef.current = false;
        setIsBusy(false);
      }
    }
  }

  function clearPreview() {
    if (previewTimeoutRef.current) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    setPreviewIndex(null);
  }

  function handleRecordingChange(recording) {
    isRecorderBusyRef.current = recording;
    setIsRecorderBusy(recording);
  }

  async function handleInputChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file && !isBusyRef.current) {
      setCurrentProjectId(null);
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

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  async function handleDrop(event) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);

    if (isBusyRef.current || isRecorderBusyRef.current) {
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (file) {
      setCurrentProjectId(null);
      await analyzeFile(file);
    }
  }

  const pushCutsHistory = useCallback((cuts) => {
    setCutsHistory((previous) => [...previous.slice(-19), cuts]);
  }, []);

  const addCutAt = useCallback(
    (seconds) => {
      if (!audioFile?.duration) {
        return;
      }

      const safeSeconds = clamp(seconds, 0.25, Math.max(0.25, audioFile.duration - 0.25));
      const alreadyNear = customCuts.some(
        (point) =>
          typeof point.position === 'number' &&
          Math.abs(point.position - safeSeconds) < 0.1,
      );
      if (alreadyNear) {
        return;
      }
      pushCutsHistory(customCuts);
      setMode('custom');
      setCustomCuts(
        [
          ...customCuts,
          {
            id: createPointId(),
            value: formatClock(safeSeconds),
            position: safeSeconds,
          },
        ].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
      );
    },
    [audioFile?.duration, customCuts, pushCutsHistory],
  );

  const handleUndoCuts = useCallback(() => {
    if (cutsHistory.length === 0) {
      return;
    }
    const restored = cutsHistory[cutsHistory.length - 1];
    setCutsHistory(cutsHistory.slice(0, -1));
    setCustomCuts(restored);
  }, [cutsHistory]);

  const handleSortAndCleanCuts = useCallback(() => {
    if (customCuts.length < 2) {
      return;
    }
    pushCutsHistory(customCuts);
    const sorted = [...customCuts].sort((a, b) => {
      const left = typeof a.position === 'number' ? a.position : parseTimeInput(a.value) ?? Infinity;
      const right = typeof b.position === 'number' ? b.position : parseTimeInput(b.value) ?? Infinity;
      return left - right;
    });
    const deduped = [];
    for (const point of sorted) {
      const pos = typeof point.position === 'number' ? point.position : parseTimeInput(point.value);
      const last = deduped[deduped.length - 1];
      const lastPos = last ? (typeof last.position === 'number' ? last.position : parseTimeInput(last.value)) : null;
      if (lastPos !== null && pos !== null && Math.abs(pos - lastPos) < 0.1) {
        continue;
      }
      deduped.push(point);
    }
    setCustomCuts(deduped);
  }, [customCuts, pushCutsHistory]);

  const handleWaveformCutMove = useCallback((id, position) => {
    if (!Number.isFinite(position)) {
      return;
    }
    const duration = audioFile?.duration ?? 0;
    const safePosition = duration > 0.5
      ? clamp(position, 0.25, duration - 0.25)
      : clamp(position, 0, Math.max(0, duration));
    if (String(id).startsWith('equal-')) {
      // Trascinare un taglio in modalità "parti uguali" converte in custom.
      const index = Number(String(id).split('-')[1]);
      const points = (plan.cutPoints ?? []).map((pos, i) => ({
        id: i === index ? createPointId() : createPointId(),
        value: formatClock(i === index ? safePosition : pos),
        position: i === index ? safePosition : pos,
      }));
      pushCutsHistory(customCuts);
      setMode('custom');
      setCustomCuts(points);
      return;
    }
    setCustomCuts((previous) =>
      previous.map((point) =>
        point.id === id
          ? { ...point, value: formatClock(safePosition), position: safePosition }
          : point,
      ),
    );
  }, [plan.cutPoints, customCuts, audioFile?.duration, pushCutsHistory]);

  const handleWaveformAddCut = useCallback((seconds) => {
    addCutAt(seconds);
  }, [addCutAt]);

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
            parsed !== null && Number.isFinite(parsed) ? parsed : null,
        };
      }),
    );
  }

  const updateCutPointPosition = useCallback((id, position) => {
    if (!Number.isFinite(position)) {
      return;
    }
    if (String(id).startsWith('equal-')) {
      handleWaveformCutMove(id, position);
      return;
    }
    setCustomCuts((previous) =>
      previous.map((point) =>
        point.id === id
          ? { ...point, value: formatClock(position), position }
          : point,
      ),
    );
  }, [handleWaveformCutMove]);

  function removeCutPoint(id) {
    pushCutsHistory(customCuts);
    setCustomCuts(customCuts.filter((point) => point.id !== id));
  }

  const handleTogglePlay = useCallback(() => {
    waveformRef.current?.togglePlay();
  }, []);

  const handleSkip = useCallback((delta) => {
    waveformRef.current?.skip(delta);
  }, []);

  const RATE_STEPS = RATE_PRESETS;

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

  const exportBitrateRef = useRef(exportBitrate);
  exportBitrateRef.current = exportBitrate;

  const handlePreviewSegment = useCallback((segmentIndex) => {
    const segment = plan.segments.find((item) => item.index === segmentIndex);
    if (!segment) {
      return;
    }
    if (previewTimeoutRef.current) {
      window.clearTimeout(previewTimeoutRef.current);
      previewTimeoutRef.current = null;
    }
    if (previewIndex === segmentIndex) {
      waveformRef.current?.pause?.();
      setPreviewIndex(null);
      return;
    }
    waveformRef.current?.seekTo(segment.start + 0.01);
    waveformRef.current?.play?.();
    setPreviewIndex(segmentIndex);
    const waitMs = Math.min(15 * 60 * 1000, Math.max(500, segment.duration * 1000));
    previewTimeoutRef.current = window.setTimeout(() => {
      waveformRef.current?.pause?.();
      setPreviewIndex(null);
      previewTimeoutRef.current = null;
    }, waitMs);
  }, [plan.segments, previewIndex]);

  const handleExportFormatChange = useCallback((formatId) => {
    const format = getExportFormat(formatId);
    setExportFormat(format.id);
    if (format.bitrates.length > 0 && !format.bitrates.includes(exportBitrateRef.current)) {
      setExportBitrate(format.defaultBitrate);
    }
    if (!format.supportsFastCopy) {
      setFastCopy(false);
    }
  }, []);

  // Auto-disinserisce il fast-copy quando sorgente/formato non sono compatibili.
  useEffect(() => {
    if (fastCopy && !canFastCopy({ formatId: exportFormat, sourceExtension: audioFile?.extension })) {
      setFastCopy(false);
    }
  }, [fastCopy, exportFormat, audioFile?.extension]);

  // Persiste le preferenze di export (default invariati se storage assente).
  useEffect(() => {
    saveSetting('ac-export-format', exportFormat);
  }, [exportFormat]);
  useEffect(() => {
    saveSetting('ac-export-bitrate', exportBitrate);
  }, [exportBitrate]);
  useEffect(() => {
    saveSetting('ac-fast-copy', fastCopy);
  }, [fastCopy]);
  useEffect(() => {
    saveSetting('ac-fade', fadeSeconds);
  }, [fadeSeconds]);
  useEffect(() => {
    saveSetting('ac-export-dest', exportDest);
  }, [exportDest]);

  // Avviso di ripresa se un export precedente è stato interrotto.
  useEffect(() => {
    const checkpoint = readCheckpoint();
    if (checkpoint && checkpoint.total >= 2) {
      const done = checkpoint.doneCount ?? checkpoint.doneNames?.length ?? 0;
      setResumeNotice(
        `Ultimo export interrotto: ${done}/${checkpoint.total} parti "${checkpoint.baseName ?? ''}". ` +
        'Ricarica lo stesso file e riesporta: in modalità cartella i file già presenti vengono saltati.',
      );
    }
  }, []);

  // Wake lock + avviso uscita durante elaborazioni lunghe (progetti pesanti in background).
  const wakeHeld = useWakeLock(isExporting);
  useEffect(() => {
    if (!isExporting) {
      return undefined;
    }
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isExporting]);

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

      const logText = await runWithLogCapture([
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
      setCutsHistory((previous) => [...previous.slice(-19), customCuts]);
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

    const audioDuration = audioFile.duration || 60;
    const estimatedSeconds = estimateCleanupSeconds(cleanupPreset, audioDuration) || 20;
    const describeTime = (seconds) => {
      if (!seconds || seconds <= 0) {
        return '';
      }
      if (seconds < 60) {
        return `~${Math.max(1, Math.round(seconds))}s`;
      }
      const minutes = Math.floor(seconds / 60);
      const remaining = Math.round(seconds % 60);
      return remaining === 0
        ? `~${minutes} min`
        : `~${minutes}:${String(remaining).padStart(2, '0')} min`;
    };
    const initialEstimateLabel = describeTime(estimatedSeconds);

    setStatusText(
      `Applico "${preset.label}" su ${formatClock(audioDuration)} di audio — stima ${initialEstimateLabel}.`,
    );
    setPhaseProgress(0.05);

    const cleanedVirtualName = `cleaned-${Date.now()}.m4a`;
    let ffmpeg = null;
    let cleanedObjectUrl = '';
    const startTime = performance.now();
    const tickerHandle = window.setInterval(() => {
      const elapsedSeconds = (performance.now() - startTime) / 1000;
      const fractional = Math.min(0.9, elapsedSeconds / Math.max(estimatedSeconds, 1));
      setPhaseProgress((current) => Math.max(current, fractional));
      const remaining = Math.max(0, estimatedSeconds - elapsedSeconds);
      const remainingLabel = describeTime(remaining) || 'pochi secondi';
      setStatusText(
        `Applico "${preset.label}" — ${remainingLabel} rimanenti (${Math.round(elapsedSeconds)}s trascorsi).`,
      );
    }, 700);

    try {
      ffmpeg = await ensureEngineReady();
      setPhaseProgress((current) => Math.max(current, 0.1));

      const filterChain = buildCleanupFilter(cleanupPreset);
      const cleanupExitCode = await ffmpeg.exec([
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
      if (cleanupExitCode !== 0) {
        throw new Error('Pulizia audio non riuscita: FFmpeg ha restituito un errore.');
      }
      setPhaseProgress((current) => Math.max(current, 0.92));

      const cleanedData = await ffmpeg.readFile(cleanedVirtualName);
      const cleanedBlob = new Blob([cleanedData], { type: 'audio/mp4' });
      cleanedObjectUrl = URL.createObjectURL(cleanedBlob);

      let probedDuration = NaN;
      try {
        probedDuration = await readAudioDurationFromBrowser(cleanedObjectUrl);
      } catch {
        probedDuration = NaN;
      }
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
      objectUrlRef.current = cleanedObjectUrl;

      if (!originalAudioBackup) {
        // Do not delete the original file from ffmpeg FS; keep it so we can restore.
      } else if (audioFile.virtualInputName !== originalAudioBackup.virtualInputName) {
        await safeDelete(ffmpeg, audioFile.virtualInputName);
      }

      setAudioFile((previous) =>
        previous
          ? {
              ...previous,
              objectUrl: cleanedObjectUrl,
              virtualInputName: cleanedVirtualName,
              extension: '.m4a',
              duration: newDuration,
              formatLabel: `${preset.label} · AAC 128k`,
              mimeType: 'audio/mp4',
              size: cleanedBlob.size,
              name: `${previous.baseName || stripExtension(previous.name)}.m4a`,
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
      if (cleanedObjectUrl) {
        URL.revokeObjectURL(cleanedObjectUrl);
      }
      if (ffmpeg) {
        await safeDelete(ffmpeg, cleanedVirtualName);
      }
    } finally {
      window.clearInterval(tickerHandle);
      setIsBusy(false);
    }
  }

  const refreshProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError('');
    try {
      const list = await listProjects();
      setProjects(list);
    } catch (error) {
      console.error(error);
      setProjectsError(error.message || 'Non sono riuscito a leggere i progetti salvati.');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeCapture === 'library') {
      refreshProjects();
    }
  }, [activeCapture, refreshProjects]);

  async function handleSaveProject() {
    if (!audioFile || isBusyRef.current) {
      return;
    }
    setSaveStatus('Salvo il progetto…');
    try {
      // Riutilizza il File originale quando corrisponde all'audio corrente
      // (niente fetch→blob duplicato in RAM); fallback a fetch per audio pulito/registrato.
      const sameAsSource = sourceFileRef.current
        && audioFile.name === sourceFileRef.current.name
        && audioFile.size === sourceFileRef.current.size;
      const audioBlob = sameAsSource
        ? sourceFileRef.current
        : await (await fetch(audioFile.objectUrl)).blob();
      try {
        const estimate = await navigator.storage?.estimate?.();
        if (estimate?.quota && estimate?.usage !== undefined) {
          const free = estimate.quota - estimate.usage;
          if (audioBlob.size > free) {
            throw new Error(
              `Spazio insufficiente nel browser (mancano ~${Math.ceil((audioBlob.size - free) / 1024 / 1024)} MB). Elimina vecchi progetti e riprova.`,
            );
          }
        }
      } catch (estimateError) {
        if (estimateError?.message?.includes('Spazio insufficiente')) {
          throw estimateError;
        }
        // estimate opzionale: ignora
      }
      const now = Date.now();
      const record = await saveStoredProject({
        id: currentProjectId ?? undefined,
        name: audioFile.baseName || audioFile.name,
        audioName: audioFile.name,
        audioExtension: audioFile.extension,
        audioMimeType: audioFile.mimeType,
        formatLabel: audioFile.formatLabel,
        duration: audioFile.duration,
        audioBlob,
        mode,
        equalParts,
        customCuts: customCuts.map((cut) => ({
          id: cut.id,
          value: cut.value,
          position:
            typeof cut.position === 'number' && Number.isFinite(cut.position)
              ? cut.position
              : null,
        })),
        bookmarks: bookmarks.map((bookmark) => ({
          id: bookmark.id,
          position: bookmark.position,
          note: bookmark.note ?? '',
        })),
        segmentNames,
        createdAt: currentProjectId ? undefined : now,
      });
      setCurrentProjectId(record.id);
      setSaveStatus('Progetto salvato.');
      window.setTimeout(() => setSaveStatus(''), 2500);
    } catch (error) {
      console.error(error);
      setSaveStatus('');
      const isQuota = error?.name === 'QuotaExceededError' || /quota|spazio/i.test(error?.message ?? '');
      setErrorText(
        isQuota
          ? 'Spazio esaurito in IndexedDB. Elimina vecchi progetti dalla libreria e riprova.'
          : error.message || 'Salvataggio progetto non riuscito.',
      );
    }
  }

  async function handleOpenProject(projectId) {
    if (!projectId || isBusy) {
      return;
    }
    try {
      const record = await loadStoredProject(projectId);
      if (!record || !record.audioBlob) {
        setProjectsError('Progetto non trovato o corrotto.');
        return;
      }

      const file = new File([record.audioBlob], record.audioName || `${record.name}.bin`, {
        type: record.audioMimeType || record.audioBlob.type,
      });
      setActiveCapture('none');
      const loaded = await analyzeFile(file);
      if (!loaded) {
        setCurrentProjectId(null);
        return;
      }
      setCurrentProjectId(record.id);
      if (record.mode === 'equal' || record.mode === 'custom') {
        setMode(record.mode);
      }
      if (Array.isArray(record.customCuts) && record.customCuts.length > 0) {
        setCustomCuts(
          record.customCuts.map((cut) => ({
            id: cut.id ?? createPointId(),
            value: cut.value ?? '',
            position:
              typeof cut.position === 'number' && Number.isFinite(cut.position)
                ? cut.position
                : null,
          })),
        );
      }
      if (Array.isArray(record.bookmarks) && record.bookmarks.length > 0) {
        setBookmarks(
          record.bookmarks.map((bookmark) => ({
            id: bookmark.id ?? createPointId(),
            position: bookmark.position,
            note: bookmark.note ?? '',
          })),
        );
      }
      if (typeof record.equalParts === 'number' && record.equalParts > 0) {
        setEqualParts(record.equalParts);
      }
      if (record.segmentNames && typeof record.segmentNames === 'object') {
        setSegmentNames(record.segmentNames);
      }
    } catch (error) {
      console.error(error);
      setProjectsError(error.message || 'Non sono riuscito ad aprire il progetto.');
    }
  }

  async function handleRenameProject(projectId, currentName) {
    if (!projectId) {
      return;
    }
    const next = window.prompt('Rinomina progetto:', currentName || '');
    if (next === null) {
      return;
    }
    const name = next.trim();
    if (!name) {
      return;
    }
    try {
      const record = await loadStoredProject(projectId);
      if (!record) {
        setProjectsError('Progetto non trovato.');
        return;
      }
      await saveStoredProject({ ...record, name });
      await refreshProjects();
    } catch (error) {
      console.error(error);
      setProjectsError(error.message || 'Rinomina non riuscita.');
    }
  }

  async function handleDuplicateProject(projectId) {
    if (!projectId) {
      return;
    }
    try {
      const record = await loadStoredProject(projectId);
      if (!record) {
        setProjectsError('Progetto non trovato.');
        return;
      }
      const { id: _dropped, ...rest } = record;
      await saveStoredProject({ ...rest, id: undefined, name: `${record.name || 'Progetto'} (copia)`, createdAt: Date.now() });
      await refreshProjects();
    } catch (error) {
      console.error(error);
      setProjectsError(error.message || 'Duplicazione non riuscita.');
    }
  }

  async function handleDeleteProject(projectId) {
    if (!projectId) {
      return;
    }
    const confirmed = window.confirm('Eliminare definitivamente questo progetto?');
    if (!confirmed) {
      return;
    }
    try {
      await deleteStoredProject(projectId);
      if (currentProjectId === projectId) {
        setCurrentProjectId(null);
      }
      await refreshProjects();
    } catch (error) {
      console.error(error);
      setProjectsError(error.message || 'Eliminazione non riuscita.');
    }
  }

  async function handleRecordedFile(file) {
    if (isBusyRef.current) {
      setErrorText('Attendi il completamento dell’operazione in corso.');
      return;
    }
    handleRecordingChange(false);
    setActiveCapture('none');
    setCurrentProjectId(null);
    await analyzeFile(file);
  }

  async function handleExportForAiStudio() {
    if (!audioFile || isBusy) {
      return;
    }
    setErrorText('');
    setIsBusy(true);
    setStatusText('Preparo una copia ottimizzata per Google AI Studio...');
    setPhaseProgress(0.15);

    const outputName = `ai-studio-${Date.now()}.m4a`;
    let ffmpeg = null;

    try {
      ffmpeg = await ensureEngineReady();
      setPhaseProgress(0.4);

      const exportExitCode = await ffmpeg.exec([
        '-hide_banner',
        '-nostats',
        '-i',
        audioFile.virtualInputName,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'aac',
        '-b:a',
        '32k',
        '-movflags',
        '+faststart',
        outputName,
      ]);
      if (exportExitCode !== 0) {
        throw new Error('Export per AI Studio non riuscito: FFmpeg ha restituito un errore.');
      }
      setPhaseProgress(0.85);

      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data], { type: 'audio/mp4' });
      const fileName = `${audioFile.baseName} - AI Studio.m4a`;
      downloadBlob(blob, fileName);

      setStatusText(
        `Copia pronta (${formatBytes(blob.size)} · mono 16kHz AAC 32k). Caricala su AI Studio e chiedi la trascrizione.`,
      );
      setTechnicalLog(
        `ai-studio export: mono 16kHz AAC 32k, ${formatBytes(blob.size)}.`,
      );
      setPhaseProgress(1);
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Export per AI Studio non riuscito.');
      setStatusText('Export per AI Studio non completato.');
      setPhaseProgress(0);
    } finally {
      if (ffmpeg) {
        await safeDelete(ffmpeg, outputName);
      }
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
      undoCuts: handleUndoCuts,
    },
    { enabled: Boolean(audioFile) && !isBusy },
  );

  function downloadUrl(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function handleCancelExport() {
    exportAbortRef.current = true;
    setStatusText('Annullamento export in corso…');
    // Interrompe un exec FFmpeg in corso; il motore verrà ricreato al prossimo uso.
    resetAfterAbort();
  }

  function handleDownloadSingle(part) {
    if (part?.url && part?.name) {
      downloadUrl(part.url, part.name);
    }
  }

  function handleDownloadZipAgain() {
    if (lastResult?.zipUrl && lastResult?.zipName) {
      downloadUrl(lastResult.zipUrl, lastResult.zipName);
    }
  }

  function handleSegmentNameChange(index, value) {
    setSegmentNames((previous) => ({ ...previous, [index]: value }));
  }

  function formatChapterClock(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
      return '00:00';
    }
    const total = Math.floor(totalSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  async function handleCopyChapters() {
    if (plan.segments.length === 0) {
      return;
    }
    const lines = plan.segments.map((segment) => {
      const title = (segmentNames[segment.index] ?? '').trim() || `Parte ${segment.index}`;
      return `${formatChapterClock(segment.start)} ${title}`;
    });
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setChaptersStatus(`Scaletta copiata (${lines.length} capitoli).`);
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
        setChaptersStatus(`Scaletta copiata (${lines.length} capitoli).`);
      } catch {
        setChaptersStatus('Copia non riuscita: seleziona e copia manualmente.');
      }
    }
    window.setTimeout(() => setChaptersStatus(''), 3500);
  }

  function handleImportTimestamps() {
    const raw = timestampDraft.trim();
    if (!raw || !audioFile?.duration) {
      return;
    }
    const duration = audioFile.duration;
    const found = [];
    const zeroLabels = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const match = trimmed.match(/^(\d{1,3}(?::\d{1,2}){1,2}(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*[-–—:.)\]]?\s*(.*)$/);
      if (!match) {
        continue;
      }
      const seconds = parseTimeInput(match[1]);
      const label = (match[2] ?? '').trim().slice(0, 60);
      if (seconds === null || !Number.isFinite(seconds) || seconds < 0 || seconds >= duration - 0.24) {
        continue;
      }
      if (seconds <= 0.24) {
        // "00:00 Titolo" non è un taglio: è il nome della prima parte.
        if (label) {
          zeroLabels.push(label);
        }
        continue;
      }
      found.push({ position: seconds, label });
    }
    if (found.length === 0 && zeroLabels.length === 0) {
      setChaptersStatus('Nessun timestamp valido trovato (es. 00:00 Intro, 12:30 Tema).');
      window.setTimeout(() => setChaptersStatus(''), 3500);
      return;
    }
    found.sort((a, b) => a.position - b.position);
    const deduped = found.filter((item, index) =>
      index === 0 || Math.abs(item.position - found[index - 1].position) >= 0.25,
    );
    if (deduped.length > 0) {
      pushCutsHistory(customCuts);
    }
    setMode('custom');
    if (deduped.length > 0) {
      setCustomCuts(deduped.map((item) => ({
        id: createPointId(),
        value: formatClock(item.position),
        position: item.position,
      })));
    }
    // L'etichetta di un timestamp descrive il segmento che INIZIA lì:
    // boundaries[k] è l'inizio del segmento k+1 (segmenti numerati da 1).
    setSegmentNames((previous) => {
      const next = { ...previous };
      if (zeroLabels.length > 0) {
        next[1] = zeroLabels[0];
      }
      const boundaries = [0, ...deduped.map((item) => item.position), duration];
      deduped.forEach((item) => {
        if (!item.label) {
          return;
        }
        const boundaryIndex = boundaries.findIndex((boundary) => Math.abs(boundary - item.position) < 0.001);
        if (boundaryIndex > 0) {
          next[boundaryIndex + 1] = item.label;
        }
      });
      return next;
    });
    setTimestampDraft('');
    setChaptersStatus(
      deduped.length > 0
        ? `Importati ${deduped.length} tagli dalla scaletta.`
        : 'Nome prima parte impostato da 00:00.',
    );
    window.setTimeout(() => setChaptersStatus(''), 3500);
  }

  function handleCreateCutsFromBookmarks() {
    if (bookmarks.length === 0 || !audioFile?.duration) {
      return;
    }
    const duration = audioFile.duration;
    const positions = [...new Set(
      bookmarks
        .map((bookmark) => bookmark.position)
        .filter((position) => Number.isFinite(position) && position > 0.24 && position < duration - 0.24),
    )].sort((a, b) => a - b);
    if (positions.length === 0) {
      return;
    }
    pushCutsHistory(customCuts);
    setMode('custom');
    setCustomCuts(positions.map((position) => ({
      id: createPointId(),
      value: formatClock(position),
      position,
    })));
  }

  function handleExportProjectJson() {
    if (!audioFile) {
      return;
    }
    const payload = {
      app: 'audio-cutter',
      version: 1,
      exportedAt: new Date().toISOString(),
      audioName: audioFile.name,
      baseName: effectiveBaseName,
      mode,
      equalParts,
      customCuts: customCuts.map((cut) => ({ value: cut.value, position: cut.position })),
      bookmarks: bookmarks.map((bookmark) => ({ position: bookmark.position, note: bookmark.note ?? '' })),
      segmentNames,
      exportFormat,
      exportBitrate,
      fadeSeconds,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${sanitizeFileName(effectiveBaseName)} - progetto.json`);
    setProjectJsonStatus('Progetto esportato in JSON.');
    window.setTimeout(() => setProjectJsonStatus(''), 3000);
  }

  async function handleImportProjectJson(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') {
        throw new Error('JSON non valido.');
      }
      if (Array.isArray(data.customCuts)) {
        pushCutsHistory(customCuts);
        setMode(data.mode === 'equal' ? 'equal' : 'custom');
        setCustomCuts(data.customCuts
          .filter((cut) => cut && (typeof cut.value === 'string' || typeof cut.position === 'number'))
          .map((cut) => {
            const position = typeof cut.position === 'number' ? cut.position : parseTimeInput(cut.value ?? '');
            return {
              id: createPointId(),
              value: typeof cut.value === 'string' ? cut.value : formatClock(position ?? 0),
              position: Number.isFinite(position) ? position : null,
            };
          }));
      }
      if (typeof data.equalParts === 'number' && data.equalParts >= 2) {
        setEqualParts(Math.min(48, Math.floor(data.equalParts)));
      }
      if (Array.isArray(data.bookmarks)) {
        setBookmarks(data.bookmarks
          .filter((bookmark) => bookmark && Number.isFinite(bookmark.position))
          .map((bookmark) => ({ id: createPointId(), position: bookmark.position, note: String(bookmark.note ?? '') }))
          .sort((a, b) => a.position - b.position));
      }
      if (data.segmentNames && typeof data.segmentNames === 'object') {
        setSegmentNames(data.segmentNames);
      }
      if (typeof data.exportFormat === 'string') {
        setExportFormat(getExportFormat(data.exportFormat).id);
      }
      if (typeof data.exportBitrate === 'number') {
        setExportBitrate(data.exportBitrate);
      }
      if (typeof data.fadeSeconds === 'number') {
        setFadeSeconds(Math.min(2, Math.max(0, data.fadeSeconds)));
      }
      setProjectJsonStatus('Progetto JSON importato (applica allo stesso audio).');
    } catch (error) {
      console.error(error);
      setProjectJsonStatus('Import non riuscito: file JSON non valido.');
    }
    window.setTimeout(() => setProjectJsonStatus(''), 3500);
  }

  async function processLoopExport() {
    if (!audioFile || !loopRegion || loopRegion.end <= loopRegion.start + 0.24 || isBusy) {
      setErrorText('Imposta prima un loop A-B di almeno 0,25 secondi.');
      return;
    }
    const format = getExportFormat(exportFormat);
    setErrorText('');
    setIsBusy(true);
    setStatusText(`Esporto la selezione ${formatClock(loopRegion.start)} → ${formatClock(loopRegion.end)}...`);
    const virtualName = `loop-${Date.now()}${format.extension}`;
    let ffmpeg = null;
    try {
      ffmpeg = await ensureEngineReady();
      const args = buildExportArgs({
        segment: { start: loopRegion.start, duration: loopRegion.end - loopRegion.start },
        inputName: audioFile.virtualInputName,
        outputName: virtualName,
        formatId: format.id,
        bitrateKbps: exportBitrate,
        fastCopy: fastCopy && canFastCopy({ formatId: format.id, sourceExtension: audioFile?.extension }),
        fadeSeconds: 0,
      });
      const exitCode = await ffmpeg.exec(args);
      if (exitCode !== 0) {
        throw new Error('Export selezione non riuscito.');
      }
      const data = await ffmpeg.readFile(virtualName);
      const blob = new Blob([data], { type: format.mime });
      downloadBlob(blob, `${sanitizeFileName(effectiveBaseName)} - selezione${format.extension}`);
      setStatusText('Selezione esportata.');
    } catch (error) {
      console.error(error);
      setErrorText(error.message || 'Export selezione non riuscito.');
    } finally {
      if (ffmpeg) {
        await safeDelete(ffmpeg, virtualName);
      }
      setIsBusy(false);
    }
  }

  async function processAndDownload() {
    if (!audioFile || plan.error || plan.segments.length < 2) {
      setErrorText(plan.error || 'Definisci almeno due parti prima di esportare.');
      return;
    }

    const format = getExportFormat(exportFormat);
    const outputExtension = format.extension;
    // Fast-copy solo se il container lo permette DAVVERO (evita MP3 in .m4a corrotti).
    const effectiveFastCopy = fastCopy && canFastCopy({ formatId: format.id, sourceExtension: audioFile?.extension });
    if (fastCopy && !effectiveFastCopy) {
      setTechnicalLog(`fast-copy richiesto ma non compatibile (${audioFile?.extension} → ${format.id}): uso re-encode.`);
    }

    setErrorText('');
    for (const url of lastResultUrlsRef.current) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    lastResultUrlsRef.current = [];
    setLastResult(null);
    setFailedExportIndex(null);
    setResumeNotice('');
    clearPreview();

    // Snapshot del job: i controlli restano usabili mentre il job gira in background.
    const jobSegments = plan.segments.map((segment) => ({ ...segment }));
    const jobBaseName = effectiveBaseName;
    const jobFormatId = format.id;
    const jobBitrate = exportBitrate;
    const jobFade = effectiveFastCopy ? 0 : fadeSeconds;
    const jobNames = jobSegments.map((segment) => buildSegmentFileName(
      jobBaseName,
      segment.index,
      outputExtension,
      segmentNames[segment.index] ?? '',
    ));
    const totalEstimate = jobSegments.reduce(
      (sum, segment) => sum + estimateExportBytes({
        durationSeconds: segment.duration,
        bitrateKbps: jobBitrate,
        formatId: jobFormatId,
      }),
      0,
    );

    const capabilities = getExportCapabilities();
    const advice = adviseExportStrategy({
      fileSizeBytes: audioFile.size ?? 0,
      totalEstimateBytes: totalEstimate,
      segmentCount: jobSegments.length,
      capabilities,
      preference: exportDest,
    });
    const destMode = advice.mode;
    setAdvisorNote([...advice.reasons, ...advice.warnings].join(' '));
    // Trattiene i Blob per il re-download solo sotto soglia: sopra, solo metadati.
    const retainBlobs = totalEstimate <= RETAIN_BLOBS_BYTES;

    // Gli handle disco vanno chiesti NEL gesto utente, prima del lavoro pesante.
    let dirHandle = null;
    let zipFileHandle = null;
    if (destMode === 'folder') {
      if (typeof window.showDirectoryPicker !== 'function') {
        setErrorText('Scrittura su cartella non supportata da questo browser. Scegli un’altra destinazione.');
        return;
      }
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (pickerError) {
        if (pickerError?.name === 'AbortError') {
          setStatusText('Scelta cartella annullata.');
          return;
        }
        throw pickerError;
      }
    } else if (destMode === 'zip-stream') {
      if (typeof window.showSaveFilePicker !== 'function') {
        setErrorText('Salvataggio diretto non supportato da questo browser. Scegli un’altra destinazione.');
        return;
      }
      try {
        zipFileHandle = await window.showSaveFilePicker({
          suggestedName: `${sanitizeFileName(jobBaseName)} - ${jobSegments.length} parti.zip`,
          types: [{ description: 'Archivio ZIP', accept: { 'application/zip': ['.zip'] } }],
        });
      } catch (pickerError) {
        if (pickerError?.name === 'AbortError') {
          setStatusText('Salvataggio annullato.');
          return;
        }
        throw pickerError;
      }
    }

    setIsBusy(true);
    setIsExporting(true);
    setExportProgress(0);
    setCurrentSegmentIndex(0);
    exportAbortRef.current = false;
    setPhaseProgress(0.05);
    setStatusText(
      `Sto creando ${jobSegments.length} parti in ${format.label} (${destMode === 'folder' ? 'cartella' : destMode === 'zip-stream' ? 'ZIP su disco' : destMode === 'zip-classic' ? 'ZIP' : 'singoli'})... ` +
      'Puoi cambiare scheda: tieni questa aperta, il job continua in background.',
    );
    const previousTitle = document.title;

    const runPrefix = `segment-${Date.now()}`;
    let ffmpeg = null;
    const createdVirtualNames = [];
    let zipWriter = null;
    let zipWritable = null;

    try {
      ffmpeg = await ensureEngineReady();
      if (destMode === 'zip-stream') {
        zipWritable = await zipFileHandle.createWritable();
        zipWriter = await createZipStreamWriter(zipWritable);
      } else if (destMode === 'zip-classic') {
        zipWriter = await createZipBlobWriter();
      }
      const exportedParts = [];
      writeCheckpoint({
        baseName: jobBaseName,
        formatId: jobFormatId,
        outputExtension,
        total: jobSegments.length,
        destMode,
        doneCount: 0,
        doneNames: [],
      });

      for (let index = 0; index < jobSegments.length; index += 1) {
        if (exportAbortRef.current) {
          throw new Error('Export annullato.');
        }
        const segment = jobSegments[index];
        const downloadName = jobNames[index];
        const virtualName = buildVirtualSegmentName(runPrefix, index, outputExtension);
        setCurrentSegmentIndex(index);
        setExportProgress(index / jobSegments.length);
        setStatusText(
          `Creo parte ${index + 1} di ${jobSegments.length} in ${format.label} (${destMode})...`,
        );
        setPhaseProgress(0.08 + (index / jobSegments.length) * 0.82);
        document.title = `(${index + 1}/${jobSegments.length}) Export audio…`;

        // Modalità cartella + ripresa: salta i file già presenti e validi.
        if (destMode === 'folder' && skipExisting) {
          try {
            const existingHandle = await dirHandle.getFileHandle(downloadName);
            const existingFile = await existingHandle.getFile();
            if (existingFile.size > 0) {
              exportedParts.push({
                name: downloadName,
                size: existingFile.size,
                duration: segment.duration,
                skipped: true,
              });
              await yieldToUI();
              continue;
            }
          } catch {
            // file assente: si esporta normalmente
          }
        }

        const args = buildExportArgs({
          segment,
          inputName: audioFile.virtualInputName,
          outputName: virtualName,
          formatId: format.id,
          bitrateKbps: jobBitrate,
          fastCopy: effectiveFastCopy,
          fadeSeconds: jobFade,
        });

        const segmentExitCode = await ffmpeg.exec(args);

        if (exportAbortRef.current) {
          throw new Error('Export annullato.');
        }

        if (segmentExitCode !== 0) {
          const failed = new Error(
            `Non sono riuscito a esportare la parte ${index + 1} in ${format.label}.`,
          );
          failed.failedIndex = index;
          throw failed;
        }

        createdVirtualNames.push(virtualName);

        let outputData = await ffmpeg.readFile(virtualName);

        if (destMode === 'folder') {
          const fileHandle = await dirHandle.getFileHandle(downloadName, { create: true });
          await writeBlobToFileHandle(fileHandle, new Blob([outputData], { type: format.mime }));
          exportedParts.push({
            name: downloadName,
            size: outputData.length,
            duration: segment.duration,
          });
        } else if (destMode === 'zip-stream' || destMode === 'zip-classic') {
          await zipWriter.add(downloadName, outputData);
          exportedParts.push({
            name: downloadName,
            size: outputData.length,
            duration: segment.duration,
          });
        } else {
          const blob = new Blob([outputData], { type: format.mime });
          let url = null;
          if (retainBlobs) {
            url = URL.createObjectURL(blob);
            lastResultUrlsRef.current.push(url);
          }
          exportedParts.push({
            name: downloadName,
            size: blob.size,
            duration: segment.duration,
            ...(url ? { url, blob } : {}),
          });
          downloadBlob(blob, downloadName);
        }

        // Libera SUBITO il segmento: mai più di uno in RAM.
        await safeDelete(ffmpeg, virtualName);
        outputData = null;
        await yieldToUI();
        writeCheckpoint({
          baseName: jobBaseName,
          formatId: jobFormatId,
          outputExtension,
          total: jobSegments.length,
          destMode,
          doneCount: exportedParts.length,
          doneNames: exportedParts.map((part) => part.name).slice(-200),
        });
      }

      let zipUrl = null;
      let zipName = '';
      if (destMode === 'zip-stream') {
        setStatusText('Finalizzo il file ZIP su disco...');
        await zipWriter.close();
        zipWriter = null;
        zipName = `${sanitizeFileName(jobBaseName)} - ${exportedParts.length} parti.zip`;
      } else if (destMode === 'zip-classic') {
        setStatusText('Creo lo ZIP...');
        const zipBlob = await zipWriter.close();
        zipWriter = null;
        zipName = `${sanitizeFileName(jobBaseName)} - ${exportedParts.length} parti.zip`;
        const url = URL.createObjectURL(zipBlob);
        lastResultUrlsRef.current.push(url);
        zipUrl = url;
        downloadBlob(zipBlob, zipName);
      }

      clearCheckpoint();
      setLastResult({
        archiveName: destMode === 'folder'
          ? `Cartella: ${exportedParts.length} parti scritte su disco`
          : destMode === 'zip-stream'
            ? `ZIP su disco: ${exportedParts.length} parti`
            : destMode === 'zip-classic'
              ? `ZIP pronto: ${exportedParts.length} parti in ${format.label}`
              : `${exportedParts.length} file ${format.label} scaricati`,
        parts: exportedParts,
        zipUrl,
        zipName,
        destMode,
        retainBlobs,
      });
      setStatusText(
        destMode === 'folder'
          ? `Fatto. ${exportedParts.length} parti scritte nella cartella scelta, senza riempire la memoria.`
          : destMode === 'zip-stream'
            ? `Fatto. ZIP scritto direttamente su disco con ${exportedParts.length} parti.`
            : destMode === 'zip-classic'
              ? `Fatto. ZIP scaricato con ${exportedParts.length} parti.${retainBlobs ? ' I singoli restano riscaricabili sotto.' : ''}`
              : `Fatto. Ho scaricato ogni parte come file ${format.label} già rinominato.${retainBlobs ? '' : ' (Re-download disattivato per risparmiare memoria.)'}`,
      );
      setTechnicalLog(
        `Export ${format.id} ${format.bitrates.length ? `${jobBitrate}k` : 'lossless'}${effectiveFastCopy ? ' fast-copy' : ''}${jobFade ? ` fade ${jobFade}s` : ''} via ${destMode}: ${exportedParts.length} file.`,
      );
      setPhaseProgress(1);
      setExportProgress(1);
    } catch (error) {
      console.error(error);
      const cancelled = exportAbortRef.current || error?.message === 'Export annullato.';
      if (cancelled) {
        setErrorText('');
        setFailedExportIndex(null);
        for (const url of lastResultUrlsRef.current) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
        lastResultUrlsRef.current = [];
        setStatusText('Export annullato. Puoi rilanciarlo quando vuoi.');
        setPhaseProgress(0);
      } else {
        if (Number.isInteger(error?.failedIndex)) {
          setFailedExportIndex(error.failedIndex);
        }
        // Le parti parziali non sono esposte (lastResult resta null): revoca subito
        // gli URL orfani per non tenere in RAM blob inutilizzabili.
        for (const url of lastResultUrlsRef.current) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
        lastResultUrlsRef.current = [];
        setErrorText(error.message || 'Non sono riuscito a esportare le parti.');
        setStatusText('Esportazione non completata.');
        setPhaseProgress(0);
      }
    } finally {
      // Su errore/annullo lo stream ZIP va chiuso o interrotto, altrimenti
      // il file parziale resta bloccato su disco.
      if (zipWriter) {
        try {
          if (exportAbortRef.current || destMode === 'zip-stream') {
            await zipWriter.abort?.();
          }
          await zipWriter.close()?.catch?.(() => {});
        } catch {
          // ignore: il file parziale resta eliminabile dall'utente
        }
        zipWriter = null;
      }
      if (ffmpeg) {
        for (const virtualName of createdVirtualNames) {
          await safeDelete(ffmpeg, virtualName);
        }
      }

      document.title = previousTitle;
      exportAbortRef.current = false;
      setIsBusy(false);
      setIsExporting(false);
    }
  }

  const canExport = Boolean(audioFile) && !plan.error && plan.segments.length >= 2 && !isBusy;
  const helperChips = [
    'Locale nel browser',
    'Un solo upload',
    `Export ${getExportFormat(exportFormat).label}`,
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

          <div className="capture-switcher" role="tablist">
            <button
              type="button"
              className={activeCapture === 'none' ? 'capture-tab capture-tab-active' : 'capture-tab'}
              onClick={() => {
                if (isRecorderBusy && !window.confirm('Registrazione in corso: abbandonarla e cambiare scheda?')) {
                  return;
                }
                setActiveCapture('none');
              }}
              disabled={isBusy}
              title={isRecorderBusy ? 'Ferma la registrazione prima di cambiare scheda' : undefined}
            >
              Carica file
            </button>
            <button
              type="button"
              className={activeCapture === 'recorder' ? 'capture-tab capture-tab-active' : 'capture-tab'}
              onClick={() => {
                if (activeCapture === 'recorder') {
                  if (isRecorderBusy && !window.confirm('Registrazione in corso: abbandonarla e chiudere?')) {
                    return;
                  }
                  setActiveCapture('none');
                  return;
                }
                setActiveCapture('recorder');
              }}
              disabled={isBusy}
            >
              Registra{isRecorderBusy ? ' ●' : ''}
            </button>
            <button
              type="button"
              className={activeCapture === 'library' ? 'capture-tab capture-tab-active' : 'capture-tab'}
              onClick={() => {
                if (isRecorderBusy && !window.confirm('Registrazione in corso: abbandonarla e aprire i progetti?')) {
                  return;
                }
                setActiveCapture(activeCapture === 'library' ? 'none' : 'library');
              }}
              disabled={isBusy}
              title={isRecorderBusy ? 'Ferma la registrazione prima di cambiare scheda' : undefined}
            >
              Progetti salvati
            </button>
          </div>

          {activeCapture === 'recorder' ? (
            <Recorder
              onRecorded={handleRecordedFile}
              disabled={isBusy}
              onClose={() => {
                if (isRecorderBusy && !window.confirm('Registrazione in corso: abbandonarla e chiudere?')) {
                  return;
                }
                setActiveCapture('none');
              }}
              onRecordingChange={handleRecordingChange}
            />
          ) : null}

          {activeCapture === 'library' ? (
            <>
                <ProjectLibrary
                projects={projects}
                currentProjectId={currentProjectId}
                onOpen={handleOpenProject}
                onDelete={handleDeleteProject}
                onRename={handleRenameProject}
                onDuplicate={handleDuplicateProject}
                onClose={() => setActiveCapture('none')}
                onRefresh={refreshProjects}
                isLoading={projectsLoading}
                disabled={isBusy}
              />
              {projectsError ? <p className="error-text">{projectsError}</p> : null}
            </>
          ) : null}

          {activeCapture === 'none' ? (
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
          ) : null}

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
              style={{ transform: `scaleX(${clamp(phaseProgress || 0.02, 0, 1)})` }}
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
                cuts={waveformCuts}
                bookmarks={bookmarks}
                loopRegion={loopRegion}
                playbackRate={playbackRate}
                zoom={zoom}
                onReady={handleWaveformReady}
                onTimeUpdate={handleWaveformTimeUpdate}
                onPlayStateChange={handleWaveformPlayStateChange}
                onCutMove={handleWaveformCutMove}
                onAddCutAt={handleWaveformAddCut}
                onBookmarkJump={handleBookmarkJump}
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
              audioDurationSeconds={audioFile?.duration ?? 0}
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
                    <button
                      type="button"
                      onClick={handleUndoCuts}
                      disabled={cutsHistory.length === 0 || isBusy}
                      title="Annulla ultima modifica ai tagli (Ctrl+Z)"
                    >
                      Annulla modifica
                    </button>
                    <button
                      type="button"
                      onClick={handleSortAndCleanCuts}
                      disabled={customCuts.length < 2 || isBusy}
                      title="Ordina per tempo e rimuovi duplicati vicini"
                    >
                      Ordina e pulisci
                    </button>
                    <button
                      type="button"
                      onClick={handleCreateCutsFromBookmarks}
                      disabled={bookmarks.length === 0 || isBusy}
                      title="Crea un taglio in corrispondenza di ogni segnalibro"
                    >
                      Tagli dai segnalibri
                    </button>
                  </div>

                  <div className="timestamp-import">
                    <label className="field">
                      <span>Incolla scaletta (uno per riga: 00:00 Intro)</span>
                      <textarea
                        className="text-input timestamp-area"
                        value={timestampDraft}
                        onChange={(event) => setTimestampDraft(event.target.value)}
                        placeholder={'00:00 Introduzione\n12:30 Tema principale\n31:00 Domande'}
                        disabled={isBusy}
                        rows={3}
                      />
                    </label>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={handleImportTimestamps}
                      disabled={!timestampDraft.trim() || isBusy}
                    >
                      Crea tagli + nomi dalla scaletta
                    </button>
                    {chaptersStatus ? <p className="save-status">{chaptersStatus}</p> : null}
                  </div>

                  <p className="helper-text">
                    Puoi scrivere i punti in secondi oppure in formato <code>mm:ss</code>{' '}
                    o <code>hh:mm:ss</code>. Doppio click sulla waveform per aggiungere un taglio.
                    Trascina le linee arancioni per spostarli.
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

            <div className="summary-stack">
            <ExportPanel
              plan={plan}
              audioFile={audioFile}
              exportFormat={exportFormat}
              onExportFormatChange={handleExportFormatChange}
              exportBitrate={exportBitrate}
              onExportBitrateChange={setExportBitrate}
              fastCopy={fastCopy}
              onFastCopyChange={setFastCopy}
              fadeSeconds={fadeSeconds}
              onFadeChange={setFadeSeconds}
              exportDest={exportDest}
              onExportDestChange={setExportDest}
              skipExisting={skipExisting}
              onSkipExistingChange={setSkipExisting}
              advisorNote={advisorNote}
              wakeHeld={wakeHeld}
              baseName={baseNameOverride}
              onBaseNameChange={setBaseNameOverride}
              segmentNames={segmentNames}
              onSegmentNameChange={handleSegmentNameChange}
              onPreviewSegment={handlePreviewSegment}
              previewIndex={previewIndex}
              canExport={canExport}
              isBusy={isBusy}
              isExporting={isExporting}
              exportProgress={exportProgress}
              currentSegmentIndex={currentSegmentIndex}
              failedExportIndex={failedExportIndex}
              onExport={processAndDownload}
              onCancelExport={handleCancelExport}
              lastResult={lastResult}
              onDownloadSingle={handleDownloadSingle}
              onDownloadZipAgain={handleDownloadZipAgain}
              loopRegion={loopRegion}
              onExportLoop={processLoopExport}
              onCopyChapters={handleCopyChapters}
              chaptersStatus={chaptersStatus}
              resumeNotice={resumeNotice}
              disabled={isBusy}
            />

            {plan.error ? <p className="error-text">{plan.error}</p> : null}
            {errorText ? <p className="error-text">{errorText}</p> : null}

            <div className="summary-column summary-sub">
              <div className="save-row">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleSaveProject}
                  disabled={!audioFile || isBusy}
                  title="Salva l'audio, i tagli e i segnalibri nel browser per riprenderli più tardi"
                >
                  {currentProjectId ? 'Aggiorna progetto salvato' : 'Salva progetto'}
                </button>
                {saveStatus ? <span className="save-status">{saveStatus}</span> : null}
              </div>

              <div className="ai-studio-row">
                <div>
                  <p className="section-label">Progetto come file</p>
                  <p className="helper-text">
                    Esporta tagli, segnalibri e nomi in JSON leggero (senza audio) da condividere
                    o riaprire su un altro PC insieme allo stesso file audio.
                  </p>
                </div>
                <div className="ai-studio-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={handleExportProjectJson}
                    disabled={!audioFile || isBusy}
                  >
                    Esporta JSON
                  </button>
                  <label className="ghost-button ghost-file">
                    Importa JSON
                    <input
                      type="file"
                      accept="application/json,.json"
                      onChange={handleImportProjectJson}
                      disabled={!audioFile || isBusy}
                      hidden
                    />
                  </label>
                </div>
                {projectJsonStatus ? <p className="save-status">{projectJsonStatus}</p> : null}
              </div>

              <div className="ai-studio-row">
                <div>
                  <p className="section-label">Trascrizione con Gemini</p>
                  <p className="helper-text">
                    Scarica una copia leggera (mono 16 kHz, AAC 32 kbps) pronta per essere
                    caricata su Google AI Studio.
                  </p>
                </div>
                <div className="ai-studio-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={handleExportForAiStudio}
                    disabled={!audioFile || isBusy}
                  >
                    Esporta per AI Studio
                  </button>
                  <a
                    className="ghost-link"
                    href="https://aistudio.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Apri AI Studio ↗
                  </a>
                </div>
              </div>

              <p className="helper-text">
                Il download crea un unico ZIP più i singoli già rinominati.
                I progetti salvati restano in questo browser, offline.
              </p>
            </div>
            </div>
          </div>
        </section>

        <section className="details">
          <div className="detail">
            <p className="section-label">Perché è più veloce</p>
            <strong>Un solo file in ingresso, ZIP unico in uscita.</strong>
            <p>
              Il sito analizza il file una volta sola, applica tutti i punti di taglio in un
              flusso guidato e scarica un unico ZIP con tutte le parti già rinominate.
              Niente più popup multipli bloccati dal browser.
            </p>
          </div>

          <div className="detail">
            <p className="section-label">Qualità</p>
            <strong>M4A, MP3, OGG o WAV a tua scelta.</strong>
            <p>
              Predefinito AAC in M4A a 128 kbps per lezioni e parlato. Taglio veloce senza
              ricodifica quando possibile, fade in/out opzionale per giunte pulite.
            </p>
          </div>

          <div className="detail">
            <p className="section-label">Stato tecnico</p>
            <strong>{technicalLog || 'In attesa del prossimo passaggio.'}</strong>
            <p>
              {lastResult
                ? `Ultimo export: ${lastResult.archiveName}`
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
                  {part.url ? (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className="mini-button"
                        onClick={() => handleDownloadSingle(part)}
                      >
                        Riscarica
                      </button>
                    </>
                  ) : null}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        <footer className="site-footer">
          <p>
            Realizzato da{' '}
            <a
              href="https://www.webnovis.com"
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="webnovis-link"
            >
              WebNovis
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}
