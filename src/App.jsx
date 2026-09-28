import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPlan,
  buildVirtualSegmentName,
} from './lib/segments.js';
import {
  buildExportArgs,
  buildSegmentFileName,
  canFastCopy,
  describeFfmpegFailure,
  estimateExportBytes,
  getExportFormat,
  naturalCopyFormat,
  sanitizeFileName,
} from './lib/export.js';
import {
  HEAVY_INPUT_BYTES,
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
import { NativeAudioPreview } from './components/NativeAudioPreview.jsx';
import {
  ActivityDock,
  EngineChip,
  LoadingBar,
  StepsBar,
  StickyExportBar,
  describeEngine,
} from './components/ProgressBars.jsx';
import { PlayerControls, RATE_PRESETS } from './components/PlayerControls.jsx';
import { BookmarksPanel } from './components/BookmarksPanel.jsx';
import { AutomationPanel } from './components/AutomationPanel.jsx';
import { ExportPanel } from './components/ExportPanel.jsx';
import { Recorder } from './components/Recorder.jsx';
import { ProjectLibrary } from './components/ProjectLibrary.jsx';
import { runFfmpeg, safeDelete, useFfmpegEngine } from './hooks/useFfmpegEngine.js';
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
  CLEANUP_PRESETS,
  buildCleanupFilter,
  buildCleanupOutputArgs,
  cleanupChangesTimeline,
  estimateCleanupSeconds,
  getCleanupPreset,
} from './lib/cleanup.js';
import {
  deleteProject as deleteStoredProject,
  listProjects,
  loadProject as loadStoredProject,
  saveProject as saveStoredProject,
} from './lib/storage.js';
import {
  decideAudioAcceptance,
  parseFfmpegInputLog,
  parseProbeJson,
} from './lib/probe.js';
import {
  isMobileDevice,
  mobileLoadLimitBytes,
  resolveExportModeForDevice,
  shouldUseNativePreview,
  shouldWarmEngineInBackground,
  waveformSampleRate,
} from './lib/device.js';
import { hardResetApp } from './lib/cacheReset.js';
import {
  FAST_LOAD_STAGES,
  LOAD_STAGES,
  clamp01,
  combineSecondsProgress,
  etaMsFromSpeed,
  formatDurationShort,
  formatSpeedFactor,
  speedFactor,
} from './lib/progress.js';

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
    // Normalizza "audio/webm;codecs=opus" ecc. prima di persistere riusare il type.
    return String(file.type).split(';')[0].trim() || file.type;
  }

  const mimeByExtension = {
    '.aac': 'audio/aac',
    '.aif': 'audio/aiff',
    '.aiff': 'audio/aiff',
    '.alac': 'audio/mp4',
    '.amr': 'audio/amr',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
  };

  return mimeByExtension[String(extension ?? '').toLowerCase()] ?? 'application/octet-stream';
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

function readAudioDurationFromBrowser(objectUrl, mimeType = '') {
  return new Promise((resolve, reject) => {
    // Skip immediato se il browser dichiara di non saper riprodurre il tipo:
    // evita 15s di timeout muto su Safari/iOS (opus/webm, wma, amr...).
    if (mimeType) {
      try {
        const probe = document.createElement('audio');
        const support = probe.canPlayType(mimeType);
        if (support === '') {
          reject(new Error('Formato non riproducibile dal browser, uso il motore locale'));
          return;
        }
      } catch (earlyError) {
        if (earlyError?.message?.includes('non riproducibile')) {
          reject(earlyError);
          return;
        }
        // canPlayType non disponibile: prosegui col tentativo normale
      }
    }

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

async function assertStorageFor(bytes) {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate?.usage !== undefined) {
      const free = estimate.quota - estimate.usage;
      if (bytes > free) {
        throw new Error(
          `Spazio insufficiente nel browser (mancano ~${Math.ceil((bytes - free) / 1024 / 1024)} MB). Elimina vecchi progetti e riprova.`,
        );
      }
    }
  } catch (estimateError) {
    if (estimateError?.message?.includes('Spazio insufficiente')) {
      throw estimateError;
    }
    // estimate opzionale: ignora
  }
}

// Velocità di export (× tempo reale) misurate su questo dispositivo, per
// stimare la durata PRIMA di premere "Taglia e scarica". Finché non ci sono
// misure si usano valori prudenti per classe di dispositivo.
const SPEED_STORAGE_KEY = 'ac-export-speed-v1';
const SPEED_CHOICE_KEY = 'ac-speed-choice';
const DEFAULT_SPEEDS = {
  desktop: { copy: 300, m4a: 60, mp3: 60, ogg: 45, wav: 150, flac: 80 },
  mobile: { copy: 80, m4a: 12, mp3: 12, ogg: 9, wav: 40, flac: 18 },
};

function exportSpeedKey({ fastCopy, formatId }) {
  return fastCopy ? 'copy' : formatId;
}

function readSpeedMemory() {
  const stored = loadSetting(SPEED_STORAGE_KEY, {});
  return stored && typeof stored === 'object' ? stored : {};
}

function expectedSpeed(key) {
  const measured = Number(readSpeedMemory()[key]);
  if (Number.isFinite(measured) && measured > 0) {
    return { speed: measured, measured: true };
  }
  const table = isMobileDevice() ? DEFAULT_SPEEDS.mobile : DEFAULT_SPEEDS.desktop;
  return { speed: table[key] ?? table.m4a, measured: false };
}

function rememberSpeed(key, speed) {
  if (!Number.isFinite(speed) || speed <= 0) {
    return;
  }
  const memory = readSpeedMemory();
  const previous = Number(memory[key]);
  // Media mobile: una misura anomala (tab in background) non sballa la stima.
  memory[key] = Number.isFinite(previous) && previous > 0 ? previous * 0.6 + speed * 0.4 : speed;
  saveSetting(SPEED_STORAGE_KEY, memory);
}

let mountSequence = 0;

/**
 * "Cancello" per annullare subito un'attesa (es. il download del motore)
 * senza interrompere il lavoro condiviso sottostante, che continua in background.
 */
function createAbortGate() {
  let rejectGate = null;
  const promise = new Promise((_, reject) => {
    rejectGate = reject;
  });
  promise.catch(() => {});
  return {
    promise,
    abort: () => {
      const error = new Error('Operazione annullata.');
      error.cancelled = true;
      rejectGate?.(error);
    },
  };
}

export default function App() {
  const inputRef = useRef(null);
  const objectUrlRef = useRef('');
  const dragDepthRef = useRef(0);
  const waveformRef = useRef(null);
  const exportAbortRef = useRef(false);
  const exportGateRef = useRef(null);
  const exportStageRef = useRef('');
  const previewTimeoutRef = useRef(null);
  const lastResultUrlsRef = useRef([]);
  const analysisIdRef = useRef(0);
  const isBusyRef = useRef(false);
  const isRecorderBusyRef = useRef(false);
  const sourceFileRef = useRef(null);
  // Input montato nel motore via WORKERFS (zero copie in RAM/wasm):
  // { ffmpeg, blob, dir, path, memfs }.
  const mountRef = useRef({ ffmpeg: null, blob: null, dir: '', path: '', memfs: false });

  const {
    ffmpegRef,
    engineInfo,
    technicalLog,
    setTechnicalLog,
    ensureReady: ensureEngineReady,
    resetAfterAbort,
  } = useFfmpegEngine();

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
  // 0 = forma d'onda adattata alla larghezza: panoramica immediata anche
  // su lezioni lunghe e rendering leggero; lo zoom resta a portata di slider.
  const [zoom, setZoom] = useState(0);
  const [loopRegion, setLoopRegion] = useState(null);
  const [loopDraft, setLoopDraft] = useState(null);
  const [bookmarks, setBookmarks] = useState([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-30);
  const [silenceMinDuration, setSilenceMinDuration] = useState(2);
  const [silenceMinSegment, setSilenceMinSegment] = useState(8);
  const [cleanupPreset, setCleanupPreset] = useState(() => {
    const saved = loadSetting('ac-cleanup-preset', 'lecture');
    return CLEANUP_PRESETS[saved] && saved !== 'none' ? saved : 'lecture';
  });
  const [shortenPauses, setShortenPauses] = useState(() => loadSetting('ac-shorten-pauses', false));
  // { presetId, label, start, duration, originalUrl, cleanedUrl } dell'ultima anteprima A/B.
  const [cleanupPreview, setCleanupPreview] = useState(null);
  // { presetId, label, shortenPauses } della pulizia applicata al file corrente.
  const [appliedCleanup, setAppliedCleanup] = useState(null);
  // Conferma breve a fine lavoro nel dock ("Fatto in 3 s").
  const [doneNote, setDoneNote] = useState(null);
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
  // true = taglio senza ricodifica (se la sorgente lo permette). Impostato a
  // ogni caricamento dalla scelta ricordata dell'utente (default: veloce).
  const [fastCopy, setFastCopy] = useState(false);
  const [fadeSeconds, setFadeSeconds] = useState(() => Number(loadSetting('ac-fade', 0)) || 0);
  const [exportDest, setExportDest] = useState(() => loadSetting('ac-export-dest', 'auto'));
  const [skipExisting, setSkipExisting] = useState(true);
  const [advisorNote, setAdvisorNote] = useState('');
  const [resumeNotice, setResumeNotice] = useState('');
  const [baseNameOverride, setBaseNameOverride] = useState('');
  const [segmentNames, setSegmentNames] = useState({});
  const [isExporting, setIsExporting] = useState(false);
  const [exportDetail, setExportDetail] = useState(null);
  const [previewIndex, setPreviewIndex] = useState(null);
  const [failedExportIndex, setFailedExportIndex] = useState(null);
  const [chaptersStatus, setChaptersStatus] = useState('');
  const [timestampDraft, setTimestampDraft] = useState('');
  const [projectJsonStatus, setProjectJsonStatus] = useState('');
  const [loadJob, setLoadJob] = useState(null);
  const [waveformError, setWaveformError] = useState('');
  const [swWaiting, setSwWaiting] = useState(false);
  // Operazione lunga non-export (silenzi, pulizia, AI, selezione A-B):
  // { kind, title, detail, frac, etaMs, speed, stage, startedAt }.
  const [task, setTask] = useState(null);
  const loadAbortRef = useRef(null);
  const audioFileRef = useRef(null);
  const loadJobRef = useRef(null);
  const timeUpdateRef = useRef({ lastAt: 0, value: 0 });

  const plan = useMemo(() => buildPlan({
    duration: audioFile?.duration ?? 0,
    mode,
    equalParts,
    customCuts,
  }), [audioFile?.duration, mode, equalParts, customCuts]);

  const backupUrlRef = useRef(null);
  backupUrlRef.current = originalAudioBackup?.objectUrl ?? null;

  useEffect(() => {
    audioFileRef.current = audioFile;
  }, [audioFile]);
  useEffect(() => {
    loadJobRef.current = loadJob;
  }, [loadJob]);
  useEffect(() => {
    const handleSwWaiting = () => setSwWaiting(true);
    window.addEventListener('app-sw-waiting', handleSwWaiting);
    return () => window.removeEventListener('app-sw-waiting', handleSwWaiting);
  }, []);

  const effectiveBaseName = baseNameOverride.trim() || audioFile?.baseName || 'audio';
  // Formato in cui la sorgente si taglia senza ricodifica (null = serve convertire).
  const naturalFormatId = naturalCopyFormat(audioFile?.extension);
  const effectiveFastCopy = Boolean(fastCopy && naturalFormatId);
  const effectiveFormatId = effectiveFastCopy ? naturalFormatId : getExportFormat(exportFormat).id;

  // Frequenza di decodifica della sola forma d'onda (3 kHz sui dispositivi deboli).
  const waveformRate = useMemo(() => waveformSampleRate(), []);

  // Su mobile con file molto pesanti la decodifica integrale per la waveform
  // (GB di PCM) uccide la tab: si usa l'anteprima nativa leggera.
  const useNativePreview = useMemo(
    () => shouldUseNativePreview({
      sizeBytes: audioFile?.size ?? 0,
      durationSeconds: audioFile?.duration ?? 0,
      sampleRate: waveformRate,
    }),
    [audioFile?.size, audioFile?.duration, waveformRate],
  );

  /**
   * Rende disponibile l'audio corrente al motore SENZA copiarlo: WORKERFS
   * legge il File/Blob a pezzi dal worker (niente lettura integrale in RAM,
   * niente copia nella memoria wasm che non si restringe mai).
   * Fallback MEMFS solo se il mount non è disponibile.
   */
  async function ensureInputMounted(ffmpeg, source = audioFileRef.current) {
    const blob = source?.blob;
    if (!blob) {
      throw new Error('Audio non più disponibile in memoria: ricarica il file.');
    }
    const current = mountRef.current;
    if (current.ffmpeg === ffmpeg && current.blob === blob && current.path) {
      return current.path;
    }
    if (current.ffmpeg === ffmpeg) {
      await releaseMount(ffmpeg);
    }
    mountSequence += 1;
    const extension = String(source.extension || getExtension(source.name || '') || '.audio').replace(/[^.a-z0-9]/gi, '') || '.audio';
    const fileName = `input${extension}`;
    const dir = `/in${mountSequence}`;
    let path = '';
    let memfs = false;
    try {
      await ffmpeg.createDir(dir);
      const mounted = await ffmpeg.mount('WORKERFS', { blobs: [{ name: fileName, data: blob }] }, dir);
      if (mounted === false) {
        throw new Error('WORKERFS non disponibile');
      }
      path = `${dir}/${fileName}`;
    } catch {
      try {
        await ffmpeg.deleteDir(dir);
      } catch {
        // ignore
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      path = `/input-${mountSequence}${extension}`;
      await ffmpeg.writeFile(path, bytes);
      memfs = true;
    }
    mountRef.current = { ffmpeg, blob, dir: memfs ? '' : dir, path, memfs };
    return path;
  }

  async function releaseMount(ffmpeg = ffmpegRef.current) {
    const current = mountRef.current;
    mountRef.current = { ffmpeg: null, blob: null, dir: '', path: '', memfs: false };
    if (!ffmpeg || current.ffmpeg !== ffmpeg || !current.path) {
      return;
    }
    try {
      if (current.memfs) {
        await safeDelete(ffmpeg, current.path);
      } else if (current.dir) {
        await ffmpeg.unmount(current.dir);
        await ffmpeg.deleteDir(current.dir);
      }
    } catch {
      // best-effort: il motore resta usabile anche con un mount orfano
    }
  }

  function handleCancelAnalysis() {
    analysisIdRef.current += 1;
    try {
      loadAbortRef.current?.abort();
    } catch {
      // ignore
    }
    loadAbortRef.current = null;
    isBusyRef.current = false;
    setIsBusy(false);
    setLoadJob(null);
    setStatusText(audioFileRef.current
      ? 'Forma d’onda interrotta: ascolto, tagli ed export restano attivi.'
      : 'Caricamento annullato. Scegli di nuovo il file quando vuoi.');
  }

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

      mountRef.current = { ffmpeg: null, blob: null, dir: '', path: '', memfs: false };
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
    // Guardia anti-crash mobile PRIMA di decodificare: su iPad/Android
    // la decodifica di file enormi uccide la tab.
    const loadLimit = mobileLoadLimitBytes();
    if (Number.isFinite(loadLimit) && file.size > loadLimit) {
      const limitMb = Math.round(loadLimit / 1024 / 1024);
      const sizeMb = Math.max(1, Math.round(file.size / 1024 / 1024));
      setErrorText(
        `File troppo grande per questo dispositivo (~${sizeMb} MB, limite ~${limitMb} MB): ` +
        'su telefono/tablet il browser esaurisce la memoria. Usa un file più corto, ' +
        'comprimilo in MP3/M4A, oppure apri il sito da un computer.',
      );
      setStatusText('File rifiutato per proteggere la memoria del dispositivo.');
      return false;
    }

    const analysisId = analysisIdRef.current + 1;
    analysisIdRef.current = analysisId;
    const isStale = () => analysisIdRef.current !== analysisId;
    const abortController = new AbortController();
    loadAbortRef.current = abortController;

    const extension = getExtension(file.name);
    const outputExtension = extension || '.audio';
    const baseName = stripExtension(file.name);
    const mimeType = getAudioMime(file, outputExtension);
    const startedAt = Date.now();
    let objectUrl = '';
    let keepObjectUrl = false;

    setErrorText('');
    setLastResult(null);
    setWaveformError('');
    isBusyRef.current = true;
    setIsBusy(true);
    setStatusText(`Leggo "${file.name}"…`);
    setLoadJob({
      active: true,
      stage: 'metadata',
      stages: FAST_LOAD_STAGES,
      frac: null,
      fileName: file.name,
      startedAt,
    });

    try {
      let duration = NaN;
      let technicalMessage = 'File pronto.';
      const formatLabel = getFormatLabel(file, outputExtension);

      objectUrl = URL.createObjectURL(file);

      // Percorso veloce: se il browser legge il file, è pronto SUBITO
      // (ascolto, forma d'onda, tagli). Il motore serve solo per esportare
      // e intanto si scarica in background.
      let browserDurationOk = false;
      try {
        duration = await readAudioDurationFromBrowser(objectUrl, mimeType);
        browserDurationOk = Number.isFinite(duration) && duration > 0;
        technicalMessage = 'Durata letta direttamente dal browser (nessun download necessario).';
      } catch {
        technicalMessage = 'Il browser non legge questo formato: uso il motore locale.';
      }
      if (isStale()) {
        return false;
      }

      if (!browserDurationOk) {
        // Percorso motore: formato che il browser non sa leggere (wma, amr, …).
        setLoadJob((previous) => previous?.active
          ? { ...previous, stage: 'engine', stages: LOAD_STAGES, frac: null }
          : previous);
        setStatusText(
          file.size > HEAVY_INPUT_BYTES
            ? 'Formato non letto dal browser e file molto grande: preparo il motore locale, può volerci un po’…'
            : 'Formato non letto dal browser: preparo il motore locale per analizzarlo…',
        );
        const ffmpeg = await ensureEngineReady();
        if (isStale()) {
          return false;
        }
        setLoadJob((previous) => previous?.active ? { ...previous, stage: 'analysis', frac: null } : previous);
        setStatusText('Analizzo il file con il motore locale…');
        const source = { blob: file, extension: outputExtension, name: file.name };
        const inputPath = await ensureInputMounted(ffmpeg, source);
        const inspection = await inspectWithEngine(ffmpeg, inputPath, analysisId);
        if (isStale()) {
          return false;
        }
        duration = inspection.durationSeconds;
        technicalMessage = `Durata letta con il motore locale${inspection.note}`;
      }

      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Durata non valida. Prova con un file audio differente.');
      }

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = objectUrl;
      keepObjectUrl = true;

      const nextAudio = {
        baseName,
        duration,
        extension: outputExtension,
        formatLabel,
        mimeType,
        name: file.name,
        objectUrl,
        size: file.size,
        // Il File è già un Blob: montato nel motore e riusato dal salvataggio
        // progetto senza nessuna copia in RAM.
        blob: file,
        lastModified: file?.lastModified ?? null,
        // false = il browser non sa riprodurlo (wma, aiff, amr…): serve un'anteprima.
        browserPlayable: browserDurationOk,
      };
      audioFileRef.current = nextAudio;
      setAudioFile(nextAudio);
      sourceFileRef.current = file instanceof File ? file : null;
      setMode('equal');
      setEqualParts(2);
      setCustomCuts([]);
      setCutsHistory([]);
      setCurrentTime(0);
      setIsPlaying(false);
      setPlaybackRate(1);
      setZoom(0);
      setLoopRegion(null);
      setLoopDraft(null);
      setBookmarks([]);
      setAppliedCleanup(null);
      setCleanupPreview(null);
      setLastDetectionSummary('');
      setBaseNameOverride('');
      setSegmentNames({});
      setPreviewIndex(null);
      // Default più veloce possibile: se la sorgente è già MP3/M4A si taglia
      // senza ricodifica (qualità identica, secondi invece di minuti), a meno
      // che l'utente non abbia scelto esplicitamente «Converti».
      setFastCopy(loadSetting(SPEED_CHOICE_KEY, 'fast') !== 'convert' && Boolean(naturalCopyFormat(outputExtension)));
      setFadeSeconds(0);
      setIsExporting(false);
      for (const url of lastResultUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      lastResultUrlsRef.current = [];

      setOriginalAudioBackup((previousBackup) => {
        if (previousBackup?.objectUrl && previousBackup.objectUrl !== objectUrl) {
          URL.revokeObjectURL(previousBackup.objectUrl);
        }
        return null;
      });

      setStatusText(
        browserDurationOk
          ? `File pronto (${formatClock(duration)}). Ascolta, segna i tagli e premi «Taglia e scarica».`
          : `File pronto (${formatClock(duration)}). Il browser non riproduce questo formato: puoi già tagliare per tempi o parti uguali, oppure creare un’anteprima ascoltabile.`,
      );
      setTechnicalLog(technicalMessage);
      // La waveform (o l'anteprima nativa) completa la barra di caricamento.
      setLoadJob(browserDurationOk
        ? (previous) => ({
          active: true,
          stage: 'waveform',
          stages: previous?.stages ?? FAST_LOAD_STAGES,
          frac: 0,
          fileName: file.name,
          startedAt,
        })
        : null);
      loadAbortRef.current = null;
      clearPreview();
      return true;
    } catch (error) {
      console.error(error);
      if (isStale()) {
        return false;
      }
      setErrorText(error.message || 'Non sono riuscito ad analizzare il file.');
      setStatusText('Qualcosa è andato storto durante l’analisi del file.');
      setLoadJob(null);
      return false;
    } finally {
      if (objectUrl && !keepObjectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      if (loadAbortRef.current === abortController) {
        loadAbortRef.current = null;
      }
      if (analysisIdRef.current === analysisId) {
        isBusyRef.current = false;
        setIsBusy(false);
      }
    }
  }

  /**
   * Durata + verifica traccia audio col motore (solo formati che il browser
   * non legge). ffprobe di ffmpeg.wasm 0.12 esce SEMPRE con -1 anche quando
   * riesce: si giudica dal contenuto del JSON, mai dal codice di uscita.
   * Se il JSON manca, fallback sul log di `ffmpeg -i` (Duration + Stream).
   */
  async function inspectWithEngine(ffmpeg, inputPath, analysisId) {
    const probeOutputName = `probe-${Date.now()}-${analysisId}.json`;
    let probe = parseProbeJson('');
    try {
      await ffmpeg.ffprobe([
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type',
        '-of', 'json',
        inputPath,
        '-o', probeOutputName,
      ]);
      probe = parseProbeJson(await ffmpeg.readFile(probeOutputName, 'utf8'));
    } catch {
      // probe inconclusiva: decide il log di ffmpeg -i
    } finally {
      await safeDelete(ffmpeg, probeOutputName);
    }

    let durationSeconds = probe.durationSeconds;
    let logHasAudio = false;
    let logHasVideo = false;
    if (!probe.ok || !probe.hasAudio || !Number.isFinite(durationSeconds)) {
      try {
        // `ffmpeg -i` senza output stampa sempre durata e stream (ed esce != 0).
        const { logText } = await runFfmpeg(ffmpeg, ['-hide_banner', '-i', inputPath], { captureLog: true });
        const parsed = parseFfmpegInputLog(logText);
        logHasAudio = parsed.hasAudio;
        logHasVideo = parsed.hasVideo;
        if (!Number.isFinite(durationSeconds) && parsed.durationSeconds > 0) {
          durationSeconds = parsed.durationSeconds;
        }
      } catch {
        // log non disponibile
      }
    }

    const decision = decideAudioAcceptance({
      ffprobeOk: probe.ok,
      ffprobeHasAudio: probe.hasAudio,
      ffmpegLogHasAudio: logHasAudio,
      ffmpegLogHasVideo: logHasVideo,
      browserDurationOk: false,
    });
    if (!decision.accept) {
      throw new Error(decision.error);
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Impossibile leggere la durata di questo file. Prova a convertirlo in MP3 o M4A.');
    }
    return {
      durationSeconds,
      note: decision.reason === 'ffmpeg-log-audio' ? ' (traccia audio confermata via log ffmpeg).' : '.',
    };
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
    const current = audioFileRef.current;
    const job = loadJobRef.current;
    // Decode di un file precedente risolta dopo il cambio: non toccare il job nuovo.
    if (job?.active && current && job.fileName && job.fileName !== current.name) {
      return;
    }
    setLoadJob((previous) => (previous?.stage === 'waveform' ? null : previous));
    if (current && Number.isFinite(duration) && duration > 0) {
      // Seconda guardia: una durata molto diversa da quella caricata è di un altro file.
      if (Math.abs(duration - current.duration) > Math.max(5, (current.duration || 0) * 0.2)) {
        return;
      }
      // La durata decodificata è esatta (quella dei metadati può essere stimata
      // sugli MP3 VBR): i tagli usano quella.
      setAudioFile((previous) =>
        previous && Math.abs((previous.duration ?? 0) - duration) > 0.05
          ? { ...previous, duration }
          : previous,
      );
    }
  }, []);

  const handleWaveformProgress = useCallback((frac) => {
    const current = audioFileRef.current;
    const job = loadJobRef.current;
    if (job?.active && current && job.fileName && job.fileName !== current.name) {
      return;
    }
    const safe = clamp01(frac);
    setLoadJob((previous) => {
      if (!previous?.active || previous.stage !== 'waveform') {
        return previous;
      }
      if (safe >= 0.95) {
        // Lettura finita: la decodifica non ha una misura → barra animata +
        // tempo che scorre (mai un 100% fermo che sembra un blocco).
        return previous.frac === null
          ? previous
          : { ...previous, frac: null, detail: 'Decodifico l’audio per la forma d’onda: intanto puoi già ascoltare e segnare i tagli.' };
      }
      // Evita re-render inutili: la barra avanza a passi di almeno 2%.
      if (previous.frac !== null && Math.abs((previous.frac ?? 0) - safe) < 0.02) {
        return previous;
      }
      return { ...previous, frac: safe };
    });
  }, []);

  const handleWaveformError = useCallback((message) => {
    const current = audioFileRef.current;
    const job = loadJobRef.current;
    if (job?.active && current && job.fileName && job.fileName !== current.name) {
      return;
    }
    setLoadJob(null);
    setWaveformError(
      'Anteprima grafica non disponibile per questo file su questo browser, ma taglio ed export restano attivi. ' +
      `Dettaglio: ${message || 'decodifica non riuscita'}`,
    );
  }, []);

  // La riproduzione emette timeupdate a ogni frame: aggiornare lo stato 60
  // volte al secondo ri-renderizza tutta l'app (jank sui dispositivi deboli).
  // 4 aggiornamenti/s bastano per il display; i seek passano subito.
  const handleWaveformTimeUpdate = useCallback((time) => {
    const tracker = timeUpdateRef.current;
    const now = performance.now();
    const jumped = Math.abs(time - tracker.value) > 1;
    if (!jumped && now - tracker.lastAt < 250) {
      return;
    }
    tracker.lastAt = now;
    tracker.value = time;
    setCurrentTime(time);
  }, []);

  const handleWaveformPlayStateChange = useCallback((playing) => {
    setIsPlaying(playing);
    if (!playing) {
      // In pausa il tempo mostrato deve essere esatto (non l'ultimo campione throttled).
      const exact = waveformRef.current?.getCurrentTime?.();
      if (Number.isFinite(exact)) {
        timeUpdateRef.current = { lastAt: performance.now(), value: exact };
        setCurrentTime(exact);
      }
    }
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
    // A 2x l'anteprima dura metà: senza dividere per la velocità sconfinerebbe nella parte dopo.
    const rate = playbackRate > 0 ? playbackRate : 1;
    const waitMs = Math.min(15 * 60 * 1000, Math.max(500, (segment.duration * 1000) / rate));
    previewTimeoutRef.current = window.setTimeout(() => {
      waveformRef.current?.pause?.();
      setPreviewIndex(null);
      previewTimeoutRef.current = null;
    }, waitMs);
  }, [plan.segments, previewIndex, playbackRate]);

  const handleExportFormatChange = useCallback((formatId) => {
    const format = getExportFormat(formatId);
    setExportFormat(format.id);
    if (format.bitrates.length > 0 && !format.bitrates.includes(exportBitrateRef.current)) {
      setExportBitrate(format.defaultBitrate);
    }
    // Scegliere un formato = convertire: la modalità veloce (stesso formato) si spegne.
    setFastCopy(false);
    saveSetting(SPEED_CHOICE_KEY, 'convert');
  }, []);

  const handleSpeedModeChange = useCallback((fast) => {
    setFastCopy(Boolean(fast));
    saveSetting(SPEED_CHOICE_KEY, fast ? 'fast' : 'convert');
  }, []);

  // La modalità veloce esiste solo se la sorgente è già MP3/M4A.
  useEffect(() => {
    if (fastCopy && audioFile && !naturalFormatId) {
      setFastCopy(false);
    }
  }, [fastCopy, audioFile, naturalFormatId]);

  // Persiste le preferenze di export (default invariati se storage assente).
  useEffect(() => {
    saveSetting('ac-export-format', exportFormat);
  }, [exportFormat]);
  useEffect(() => {
    saveSetting('ac-export-bitrate', exportBitrate);
  }, [exportBitrate]);
  useEffect(() => {
    saveSetting('ac-fade', fadeSeconds);
  }, [fadeSeconds]);
  useEffect(() => {
    saveSetting('ac-export-dest', exportDest);
  }, [exportDest]);
  useEffect(() => {
    saveSetting('ac-cleanup-preset', cleanupPreset);
  }, [cleanupPreset]);
  useEffect(() => {
    saveSetting('ac-shorten-pauses', shortenPauses);
  }, [shortenPauses]);

  // Le anteprime A/B sono Blob in memoria: liberale quando cambiano o si chiudono.
  const cleanupPreviewRef = useRef(null);
  useEffect(() => {
    const previous = cleanupPreviewRef.current;
    cleanupPreviewRef.current = cleanupPreview;
    if (previous && previous !== cleanupPreview) {
      URL.revokeObjectURL(previous.originalUrl);
      URL.revokeObjectURL(previous.cleanedUrl);
    }
  }, [cleanupPreview]);

  const doneTimerRef = useRef(null);
  const flashDone = useCallback((title, detail = '') => {
    window.clearTimeout(doneTimerRef.current);
    setDoneNote({ title, detail, at: Date.now() });
    doneTimerRef.current = window.setTimeout(() => setDoneNote(null), 5000);
  }, []);
  useEffect(() => () => window.clearTimeout(doneTimerRef.current), []);

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

  // Wake lock + avviso uscita durante QUALUNQUE elaborazione lunga (export,
  // pulizia, silenzi, download motore): lo schermo spento sospende la tab.
  const longWorkActive = isExporting || Boolean(task) || engineInfo.phase === 'downloading'
    || engineInfo.phase === 'compiling' || Boolean(loadJob?.active && loadJob.stage !== 'waveform');
  const wakeHeld = useWakeLock(longWorkActive);
  useEffect(() => {
    if (!isExporting && !task) {
      return undefined;
    }
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isExporting, task]);

  // Motore in background appena il file è pronto (e la forma d'onda ha finito
  // di decodificare, per non sommare i picchi di memoria): quando l'utente
  // preme "Taglia e scarica" il motore è già lì. Mai su Risparmio dati / 2G.
  const waveformPending = Boolean(loadJob?.active);
  useEffect(() => {
    if (!audioFile || waveformPending || engineInfo.phase !== 'idle' || !shouldWarmEngineInBackground()) {
      return undefined;
    }
    const handle = window.setTimeout(() => {
      ensureEngineReady().catch(() => {
        // l'errore resta visibile nel chip del motore, con "Riprova"
      });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [audioFile, waveformPending, engineInfo.phase, ensureEngineReady]);

  const taskAbortRef = useRef(false);
  const taskGateRef = useRef(null);
  const taskStageRef = useRef('');

  /**
   * Esegue un'operazione del motore con stato SEMPRE visibile: fase motore
   * (download/compilazione reali), poi avanzamento misurato sui secondi di
   * audio elaborati, velocità ed ETA. Annullabile.
   */
  async function runEngineTask({ kind, title, durationSeconds }, work) {
    const startedAt = Date.now();
    const gate = createAbortGate();
    taskGateRef.current = gate;
    taskStageRef.current = 'engine';
    taskAbortRef.current = false;
    isBusyRef.current = true;
    setIsBusy(true);
    setErrorText('');
    setTask({ kind, title, stage: 'engine', frac: null, detail: '', startedAt, speed: 0, etaMs: null });
    try {
      // Annullare durante il download del motore sblocca subito la UI senza
      // buttare il download (che continua e resta pronto per dopo).
      const ffmpeg = await Promise.race([ensureEngineReady(), gate.promise]);
      if (taskAbortRef.current) {
        throw new Error('Operazione annullata.');
      }
      const inputPath = await ensureInputMounted(ffmpeg);
      const runStartedAt = performance.now();
      taskStageRef.current = 'running';
      setTask((previous) => previous ? { ...previous, stage: 'running', frac: 0 } : previous);
      const onProgress = (frac, seconds) => {
        const speed = speedFactor(seconds, performance.now() - runStartedAt);
        const etaMs = etaMsFromSpeed({ remainingSeconds: Math.max(0, durationSeconds - seconds), speed });
        setTask((previous) => previous
          ? { ...previous, frac: frac === null ? null : Math.min(0.99, frac), speed, etaMs, processedSeconds: seconds }
          : previous);
      };
      return await work({ ffmpeg, inputPath, onProgress });
    } catch (error) {
      if (taskAbortRef.current) {
        const cancelled = new Error('Operazione annullata.');
        cancelled.cancelled = true;
        throw cancelled;
      }
      throw error;
    } finally {
      taskAbortRef.current = false;
      taskGateRef.current = null;
      taskStageRef.current = '';
      setTask(null);
      isBusyRef.current = false;
      setIsBusy(false);
    }
  }

  function handleCancelTask() {
    taskAbortRef.current = true;
    setStatusText('Annullo l’operazione…');
    taskGateRef.current?.abort();
    if (taskStageRef.current === 'running') {
      // Terminate interrompe l'exec in corso; il motore si ricrea al prossimo uso.
      resetAfterAbort();
    }
  }

  function failureMessage(error, fallback, tailText = '') {
    return describeFfmpegFailure(`${tailText}\n${error?.message ?? ''}`) || error?.message || fallback;
  }

  async function handleDetectSilences() {
    if (!audioFile || isBusyRef.current) {
      return;
    }
    const duration = audioFile.duration;
    setStatusText('Cerco le pause lunghe nell’audio…');
    try {
      const silences = await runEngineTask(
        { kind: 'silence', title: 'Cerco le pause per creare i capitoli', durationSeconds: duration },
        async ({ ffmpeg, inputPath, onProgress }) => {
          const filter = buildSilenceDetectFilter({
            thresholdDb: silenceThresholdDb,
            minSilenceSeconds: silenceMinDuration,
          });
          const result = await runFfmpeg(ffmpeg, [
            '-hide_banner',
            '-i',
            inputPath,
            '-af',
            filter,
            '-f',
            'null',
            '-',
          ], { durationSeconds: duration, onProgress, captureLog: true });
          if (result.exitCode !== 0) {
            throw new Error(describeFfmpegFailure(result.tailText) || 'Analisi dei silenzi non riuscita.');
          }
          return parseSilenceLog(result.logText);
        },
      );
      const cutPositions = silencesToCutPoints({
        silences,
        duration,
        minSegmentLength: silenceMinSegment,
      });

      if (cutPositions.length === 0) {
        setLastDetectionSummary(
          `Nessun taglio utile con soglia ${silenceThresholdDb} dB e pausa ≥ ${silenceMinDuration}s. Prova ad abbassare la pausa o ad alzare la soglia.`,
        );
        setStatusText('Analisi completata: nessuna pausa adatta.');
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
        `${cutPositions.length === 1 ? '1 taglio automatico' : `${cutPositions.length} tagli automatici`} da `
        + `${silences.length === 1 ? '1 pausa rilevata' : `${silences.length} pause rilevate`}.`,
      );
      setStatusText(
        `${silences.length === 1 ? 'Rilevata 1 pausa' : `Rilevate ${silences.length} pause`}; `
        + `${cutPositions.length === 1 ? 'suggerito 1 punto' : `suggeriti ${cutPositions.length} punti`} di taglio.`,
      );
      setTechnicalLog(
        `silencedetect: threshold=${silenceThresholdDb}dB, min=${silenceMinDuration}s → ${silences.length} gap.`,
      );
      flashDone(
        `${cutPositions.length === 1 ? '1 taglio creato' : `${cutPositions.length} tagli creati`} dalle pause`,
        'Controllali sulla forma d’onda e trascinali se serve.',
      );
    } catch (error) {
      if (error?.cancelled) {
        setStatusText('Ricerca delle pause annullata.');
        return;
      }
      console.error(error);
      setErrorText(failureMessage(error, 'Non sono riuscito ad analizzare i silenzi.'));
      setStatusText('Analisi dei silenzi non completata.');
    }
  }

  function cleanupSpeedKey(presetId) {
    return `cleanup-${presetId}`;
  }

  const cleanupEstimateLabel = useMemo(() => {
    const seconds = estimateCleanupSeconds(cleanupPreset, audioFile?.duration ?? 0, {
      mobile: isMobileDevice(),
      measuredSpeed: Number(readSpeedMemory()[cleanupSpeedKey(cleanupPreset)]) || 0,
    });
    if (!seconds) {
      return '';
    }
    return `${seconds < 8 ? 'pochi secondi' : `~${formatDurationShort(seconds)}`}${engineInfo.phase !== 'ready' ? ' + preparazione motore' : ''}`;
    // appliedCleanup: ricalcola dopo una pulizia (velocità appena misurata).
  }, [cleanupPreset, audioFile?.duration, engineInfo.phase, appliedCleanup]);

  async function handleApplyCleanup() {
    if (!audioFile || isBusyRef.current) {
      return;
    }
    const preset = getCleanupPreset(cleanupPreset);
    if (!preset || preset.filters.length === 0) {
      return;
    }
    const sourceAudio = audioFile;
    const audioDuration = sourceAudio.duration || 60;
    const changesTimeline = cleanupChangesTimeline({ shortenPauses });
    const cleanedVirtualName = `cleaned-${Date.now()}.m4a`;
    let cleanedObjectUrl = '';
    let measuredSpeed = 0;
    setCleanupPreview(null);
    waveformRef.current?.pause?.();
    setStatusText(`Applico "${preset.label}" su ${formatClock(audioDuration)} di audio…`);

    try {
      const cleanedBlob = await runEngineTask(
        { kind: 'cleanup', title: `Pulizia audio: ${preset.label}`, durationSeconds: audioDuration },
        async ({ ffmpeg, inputPath, onProgress }) => {
          try {
            const startedAt = performance.now();
            const result = await runFfmpeg(ffmpeg, [
              '-hide_banner',
              '-i',
              inputPath,
              '-map',
              '0:a:0',
              '-vn',
              '-af',
              buildCleanupFilter(cleanupPreset, { shortenPauses }),
              ...buildCleanupOutputArgs(cleanupPreset),
              cleanedVirtualName,
            ], { durationSeconds: audioDuration, onProgress });
            if (result.exitCode !== 0) {
              throw new Error(describeFfmpegFailure(result.tailText) || 'Pulizia audio non riuscita: FFmpeg ha restituito un errore.');
            }
            measuredSpeed = speedFactor(audioDuration, performance.now() - startedAt);
            const cleanedData = await ffmpeg.readFile(cleanedVirtualName);
            return new Blob([cleanedData], { type: 'audio/mp4' });
          } finally {
            // Il risultato vive nel Blob (montato via WORKERFS al prossimo uso):
            // niente copia residente nella memoria wasm.
            await safeDelete(ffmpeg, cleanedVirtualName);
          }
        },
      );
      rememberSpeed(cleanupSpeedKey(cleanupPreset), measuredSpeed);
      cleanedObjectUrl = URL.createObjectURL(cleanedBlob);

      let probedDuration = NaN;
      try {
        probedDuration = await readAudioDurationFromBrowser(cleanedObjectUrl, 'audio/mp4');
      } catch {
        probedDuration = NaN;
      }
      const newDuration = changesTimeline && Number.isFinite(probedDuration) && probedDuration > 0
        ? probedDuration
        : sourceAudio.duration;

      setOriginalAudioBackup((previousBackup) => {
        if (previousBackup) {
          return previousBackup;
        }
        return {
          objectUrl: sourceAudio.objectUrl,
          blob: sourceAudio.blob,
          extension: sourceAudio.extension,
          duration: sourceAudio.duration,
          formatLabel: sourceAudio.formatLabel,
          mimeType: sourceAudio.mimeType,
          size: sourceAudio.size,
          baseName: sourceAudio.baseName,
          name: sourceAudio.name,
          lastModified: sourceAudio.lastModified ?? null,
          browserPlayable: sourceAudio.browserPlayable,
          previewOnly: sourceAudio.previewOnly,
        };
      });

      // L'objectUrl dell'originale resta vivo dentro il backup; una pulizia
      // successiva (su audio già pulito) può revocare l'intermedio.
      if (originalAudioBackup && sourceAudio.objectUrl !== originalAudioBackup.objectUrl) {
        URL.revokeObjectURL(sourceAudio.objectUrl);
      }
      objectUrlRef.current = cleanedObjectUrl;

      const nextAudio = {
        ...sourceAudio,
        objectUrl: cleanedObjectUrl,
        extension: '.m4a',
        duration: newDuration,
        formatLabel: `${preset.label} · AAC ${preset.bitrateKbps}k${preset.mono ? ' mono' : ''}`,
        mimeType: 'audio/mp4',
        size: cleanedBlob.size,
        name: `${sourceAudio.baseName || stripExtension(sourceAudio.name)}.m4a`,
        blob: cleanedBlob,
        browserPlayable: true,
        previewOnly: false,
      };
      audioFileRef.current = nextAudio;
      setAudioFile(nextAudio);
      if (changesTimeline) {
        // Le pause accorciate spostano i tempi: i vecchi punti non corrispondono più.
        setCustomCuts([]);
        setBookmarks([]);
        setLoopRegion(null);
        setLoopDraft(null);
      }
      setCurrentTime(0);
      setIsPlaying(false);
      setLastDetectionSummary('');
      setAppliedCleanup({ presetId: preset.id, label: preset.label, shortenPauses: changesTimeline });
      const tookLabel = measuredSpeed > 0 ? formatDurationShort(audioDuration / measuredSpeed) : '';
      setStatusText(
        `Pulizia applicata (${preset.label}${changesTimeline ? ', pause accorciate' : ''}). `
        + (changesTimeline ? 'Durata aggiornata: rimetti i tagli.' : 'Tagli e segnalibri conservati.'),
      );
      setTechnicalLog(`cleanup ${preset.id}: ${formatSpeedFactor(measuredSpeed) ?? '—'} tempo reale.`);
      flashDone(`Pulizia applicata: ${preset.label}`, tookLabel ? `Completata in ${tookLabel}` : '');
    } catch (error) {
      if (cleanedObjectUrl) {
        URL.revokeObjectURL(cleanedObjectUrl);
      }
      if (error?.cancelled) {
        setStatusText('Pulizia annullata: il file originale è invariato.');
        return;
      }
      console.error(error);
      setErrorText(failureMessage(error, 'Pulizia dell’audio non completata.'));
      setStatusText('Pulizia non completata.');
    }
  }

  /**
   * Anteprima A/B: 20 s dalla posizione attuale, originale e pulito codificati
   * allo stesso modo. Pre-roll di 4 s scartato: denoise adattivo e livellatore
   * hanno bisogno di qualche secondo per "sentire" il rumore e il livello,
   * così l'anteprima suona come il risultato sul file intero.
   */
  async function handleCleanupPreview() {
    const sourceAudio = audioFileRef.current;
    if (!sourceAudio || isBusyRef.current) {
      return;
    }
    const preset = getCleanupPreset(cleanupPreset);
    if (!preset || preset.filters.length === 0) {
      return;
    }
    waveformRef.current?.pause?.();
    const clipSeconds = Math.min(20, Math.max(1, sourceAudio.duration));
    const position = waveformRef.current?.getCurrentTime?.() ?? currentTime;
    const start = clamp(position, 0, Math.max(0, sourceAudio.duration - clipSeconds));
    const preroll = Math.min(4, start);
    const stamp = Date.now();
    const originalName = `ab-original-${stamp}.m4a`;
    const cleanedName = `ab-cleaned-${stamp}.m4a`;
    const commonOut = ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '160k'];
    try {
      const clips = await runEngineTask(
        { kind: 'cleanup-preview', title: `Anteprima A/B: ${preset.label}`, durationSeconds: clipSeconds * 2 },
        async ({ ffmpeg, inputPath, onProgress }) => {
          try {
            const original = await runFfmpeg(ffmpeg, [
              '-hide_banner',
              '-ss', start.toFixed(3),
              '-t', clipSeconds.toFixed(3),
              '-i', inputPath,
              '-map', '0:a:0', '-vn',
              ...(preset.mono ? ['-ac', '1'] : []),
              ...commonOut,
              originalName,
            ], { durationSeconds: clipSeconds, onProgress: (frac, seconds) => onProgress(frac === null ? null : frac / 2, seconds) });
            if (original.exitCode !== 0) {
              throw new Error(describeFfmpegFailure(original.tailText) || 'Anteprima non riuscita.');
            }
            const cleaned = await runFfmpeg(ffmpeg, [
              '-hide_banner',
              '-ss', (start - preroll).toFixed(3),
              '-t', (clipSeconds + preroll).toFixed(3),
              '-i', inputPath,
              '-map', '0:a:0', '-vn',
              '-af', `${buildCleanupFilter(cleanupPreset)},atrim=start=${preroll.toFixed(3)},asetpts=PTS-STARTPTS`,
              ...(preset.mono ? ['-ac', '1'] : []),
              ...commonOut,
              cleanedName,
            ], {
              durationSeconds: clipSeconds,
              onProgress: (frac, seconds) => onProgress(frac === null ? null : 0.5 + frac / 2, clipSeconds + seconds),
            });
            if (cleaned.exitCode !== 0) {
              throw new Error(describeFfmpegFailure(cleaned.tailText) || 'Anteprima non riuscita.');
            }
            const originalData = await ffmpeg.readFile(originalName);
            const cleanedData = await ffmpeg.readFile(cleanedName);
            return {
              original: new Blob([originalData], { type: 'audio/mp4' }),
              cleaned: new Blob([cleanedData], { type: 'audio/mp4' }),
            };
          } finally {
            await safeDelete(ffmpeg, originalName);
            await safeDelete(ffmpeg, cleanedName);
          }
        },
      );
      if (audioFileRef.current?.blob !== sourceAudio.blob) {
        return;
      }
      setCleanupPreview({
        presetId: preset.id,
        label: preset.label,
        start,
        duration: clipSeconds,
        originalUrl: URL.createObjectURL(clips.original),
        cleanedUrl: URL.createObjectURL(clips.cleaned),
      });
      setStatusText(`Anteprima pronta: confronta originale e "${preset.label}" e poi applica a tutto il file.`);
    } catch (error) {
      if (error?.cancelled) {
        setStatusText('Anteprima annullata.');
        return;
      }
      console.error(error);
      setErrorText(failureMessage(error, 'Anteprima non riuscita.'));
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

  /**
   * Operazioni su IndexedDB (salva/apri/duplica): non misurabili a byte, ma
   * con file grandi su telefono durano secondi. Stato visibile nel dock con
   * tempo che scorre, mai uno schermo muto.
   */
  async function runStorageTask({ title, detail }, work) {
    isBusyRef.current = true;
    setIsBusy(true);
    setTask({ kind: 'storage', title, detail, frac: null, stage: 'running', startedAt: Date.now(), cancellable: false });
    try {
      return await work();
    } finally {
      setTask(null);
      isBusyRef.current = false;
      setIsBusy(false);
    }
  }

  async function handleSaveProject() {
    if (!audioFile || isBusyRef.current) {
      return;
    }
    setSaveStatus('Salvo il progetto…');
    try {
      await runStorageTask(
        {
          title: currentProjectId ? 'Aggiorno il progetto salvato' : 'Salvo il progetto nel browser',
          detail: `${formatBytes(audioFile.size)} di audio + tagli e segnalibri`,
        },
        () => saveProjectNow(),
      );
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

  async function saveProjectNow() {
    // Ordine a costo zero: blob già in mano > File originale > rilettura.
    // (Niente fetch→blob duplicato in RAM quando evitabile.)
    const sameAsSource = Boolean(sourceFileRef.current)
      && audioFile.name === sourceFileRef.current.name
      && audioFile.size === sourceFileRef.current.size
      && audioFile.lastModified !== undefined
      && audioFile.lastModified === sourceFileRef.current.lastModified;
    const audioBlob = audioFile.blob
      ?? (sameAsSource
        ? sourceFileRef.current
        : await (await fetch(audioFile.objectUrl)).blob());
    await assertStorageFor(audioBlob.size);
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
      exportFormat,
      exportBitrate,
      fadeSeconds,
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
    flashDone('Progetto salvato', 'Lo ritrovi in «Progetti salvati», anche offline.');
    window.setTimeout(() => setSaveStatus(''), 2500);
  }

  async function handleOpenProject(projectId) {
    if (!projectId || isBusy) {
      return;
    }
    try {
      const record = await runStorageTask(
        { title: 'Apro il progetto salvato', detail: 'Leggo audio e tagli dal browser…' },
        () => loadStoredProject(projectId),
      );
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
      // Impostazioni export salvate col progetto (vecchi record: default invariati).
      if (typeof record.exportFormat === 'string') {
        // Solo il formato di conversione: la modalità veloce/converti resta quella scelta.
        setExportFormat(getExportFormat(record.exportFormat).id);
      }
      if (typeof record.exportBitrate === 'number' && record.exportBitrate > 0) {
        setExportBitrate(record.exportBitrate);
      }
      if (typeof record.fadeSeconds === 'number' && record.fadeSeconds >= 0) {
        setFadeSeconds(Math.min(2, Math.max(0, record.fadeSeconds)));
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
      // La copia ricopia l'intero blob: stesso pre-check quota del salvataggio.
      await assertStorageFor(record.size ?? record.audioBlob?.size ?? 0);
      const { id: _dropped, ...rest } = record;
      await runStorageTask(
        { title: 'Duplico il progetto', detail: formatBytes(record.audioBlob?.size ?? record.size ?? 0) },
        () => saveStoredProject({ ...rest, id: undefined, name: `${record.name || 'Progetto'} (copia)`, createdAt: Date.now() }),
      );
      await refreshProjects();
    } catch (error) {
      console.error(error);
      const isQuota = error?.name === 'QuotaExceededError' || /quota|spazio/i.test(error?.message ?? '');
      setProjectsError(
        isQuota
          ? 'Spazio esaurito in IndexedDB. Elimina vecchi progetti e riprova.'
          : error.message || 'Duplicazione non riuscita.',
      );
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

  async function handleMakePlayablePreview() {
    const sourceAudio = audioFileRef.current;
    if (!sourceAudio || isBusyRef.current) {
      return;
    }
    const duration = sourceAudio.duration;
    const outputName = `preview-${Date.now()}.m4a`;
    setStatusText('Creo un’anteprima ascoltabile (solo per l’ascolto: l’export usa sempre l’originale)…');
    try {
      const previewBlob = await runEngineTask(
        { kind: 'preview', title: 'Creo l’anteprima ascoltabile', durationSeconds: duration },
        async ({ ffmpeg, inputPath, onProgress }) => {
          try {
            // Mono 22kHz 48k: leggera da generare e da decodificare per la forma d'onda.
            const result = await runFfmpeg(ffmpeg, [
              '-hide_banner',
              '-i', inputPath,
              '-map', '0:a:0',
              '-vn',
              '-ac', '1',
              '-ar', '22050',
              '-c:a', 'aac',
              '-aac_coder', 'fast',
              '-b:a', '48k',
              '-movflags', '+faststart',
              outputName,
            ], { durationSeconds: duration, onProgress });
            if (result.exitCode !== 0) {
              throw new Error(describeFfmpegFailure(result.tailText) || 'Anteprima non riuscita.');
            }
            const data = await ffmpeg.readFile(outputName);
            return new Blob([data], { type: 'audio/mp4' });
          } finally {
            await safeDelete(ffmpeg, outputName);
          }
        },
      );
      const current = audioFileRef.current;
      if (!current || current.blob !== sourceAudio.blob) {
        return;
      }
      const previewUrl = URL.createObjectURL(previewBlob);
      if (current.objectUrl && current.objectUrl !== previewUrl) {
        URL.revokeObjectURL(current.objectUrl);
      }
      objectUrlRef.current = previewUrl;
      const nextAudio = { ...current, objectUrl: previewUrl, browserPlayable: true, previewOnly: true };
      audioFileRef.current = nextAudio;
      setAudioFile(nextAudio);
      setLoadJob({
        active: true,
        stage: 'waveform',
        stages: FAST_LOAD_STAGES,
        frac: 0,
        fileName: current.name,
        startedAt: Date.now(),
      });
      setStatusText('Anteprima pronta: ascolta e segna i tagli. L’export userà il file originale.');
    } catch (error) {
      if (error?.cancelled) {
        setStatusText('Anteprima annullata: puoi comunque tagliare per tempi o parti uguali.');
        return;
      }
      console.error(error);
      setErrorText(failureMessage(error, 'Anteprima non riuscita.'));
    }
  }

  async function handleExportForAiStudio() {
    if (!audioFile || isBusyRef.current) {
      return;
    }
    const duration = audioFile.duration;
    const outputName = `ai-studio-${Date.now()}.m4a`;
    const fileName = `${audioFile.baseName} - AI Studio.m4a`;
    setStatusText('Preparo una copia ottimizzata per Google AI Studio…');
    try {
      const blob = await runEngineTask(
        { kind: 'ai', title: 'Copia leggera per AI Studio', durationSeconds: duration },
        async ({ ffmpeg, inputPath, onProgress }) => {
          try {
            const result = await runFfmpeg(ffmpeg, [
              '-hide_banner',
              '-i',
              inputPath,
              // Catena pulita per la trascrizione: resample 16kHz e taglia-rumore basso
              // che ruba bit a 32k. Il downmix mono resta a -ac 1 (sicuro anche su mono).
              '-af',
              'aresample=16000,highpass=f=80',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-c:a',
              'aac',
              '-aac_coder',
              'fast',
              '-b:a',
              '32k',
              '-movflags',
              '+faststart',
              outputName,
            ], { durationSeconds: duration, onProgress });
            if (result.exitCode !== 0) {
              throw new Error(describeFfmpegFailure(result.tailText) || 'Export per AI Studio non riuscito: FFmpeg ha restituito un errore.');
            }
            const data = await ffmpeg.readFile(outputName);
            return new Blob([data], { type: 'audio/mp4' });
          } finally {
            await safeDelete(ffmpeg, outputName);
          }
        },
      );
      downloadBlob(blob, fileName);
      setStatusText(
        `Copia pronta (${formatBytes(blob.size)} · mono 16kHz AAC 32k). Caricala su AI Studio e chiedi la trascrizione.`,
      );
      setTechnicalLog(`ai-studio export: mono 16kHz AAC 32k, ${formatBytes(blob.size)}.`);
      flashDone('Copia per AI Studio scaricata', `${formatBytes(blob.size)} · mono 16 kHz`);
    } catch (error) {
      if (error?.cancelled) {
        setStatusText('Export per AI Studio annullato.');
        return;
      }
      console.error(error);
      setErrorText(failureMessage(error, 'Export per AI Studio non riuscito.'));
      setStatusText('Export per AI Studio non completato.');
    }
  }

  function handleRestoreOriginal() {
    if (!originalAudioBackup || isBusyRef.current) {
      return;
    }
    // L'originale vive nel suo Blob: nessuna operazione del motore necessaria,
    // verrà rimontato (zero copie) al prossimo taglio.
    if (audioFile?.objectUrl && audioFile.objectUrl !== originalAudioBackup.objectUrl) {
      URL.revokeObjectURL(audioFile.objectUrl);
    }
    objectUrlRef.current = originalAudioBackup.objectUrl;
    const restored = audioFile
      ? {
          ...audioFile,
          objectUrl: originalAudioBackup.objectUrl,
          extension: originalAudioBackup.extension,
          duration: originalAudioBackup.duration,
          formatLabel: originalAudioBackup.formatLabel,
          mimeType: originalAudioBackup.mimeType,
          size: originalAudioBackup.size,
          baseName: originalAudioBackup.baseName ?? audioFile.baseName,
          name: originalAudioBackup.name ?? audioFile.name,
          lastModified: originalAudioBackup.lastModified ?? audioFile.lastModified,
          blob: originalAudioBackup.blob ?? null,
          browserPlayable: originalAudioBackup.browserPlayable ?? true,
          previewOnly: originalAudioBackup.previewOnly ?? false,
        }
      : null;
    audioFileRef.current = restored;
    setAudioFile(restored);
    // Senza accorciare le pause la durata è la stessa: tagli e segnalibri restano validi.
    if (appliedCleanup?.shortenPauses !== false) {
      setCustomCuts([]);
      setBookmarks([]);
      setLoopRegion(null);
      setLoopDraft(null);
    }
    setCurrentTime(0);
    setIsPlaying(false);
    setAppliedCleanup(null);
    setCleanupPreview(null);
    setLastDetectionSummary('');
    setOriginalAudioBackup(null);
    setErrorText('');
    setStatusText('Versione originale ripristinata.');
    setTechnicalLog('cleanup: ripristino originale completato.');
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
    exportGateRef.current?.abort();
    if (exportStageRef.current !== 'engine') {
      // Interrompe un exec FFmpeg in corso; il motore verrà ricreato al prossimo uso
      // e l'audio rimontato (zero copie) da ensureInputMounted. Durante il download
      // del motore invece si abbandona solo l'attesa: il download prosegue.
      resetAfterAbort();
    }
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
    if (!audioFile || !loopRegion || loopRegion.end <= loopRegion.start + 0.24 || isBusyRef.current) {
      setErrorText('Imposta prima un loop A-B di almeno 0,25 secondi.');
      return;
    }
    const format = getExportFormat(effectiveFormatId);
    const region = { ...loopRegion };
    const selectionSeconds = region.end - region.start;
    const virtualName = `loop-${Date.now()}${format.extension}`;
    const copy = effectiveFastCopy && canFastCopy({ formatId: format.id, sourceExtension: audioFile.extension });
    setStatusText(`Esporto la selezione ${formatClock(region.start)} → ${formatClock(region.end)}…`);
    try {
      const blob = await runEngineTask(
        { kind: 'loop', title: `Esporto la selezione A-B (${formatClock(selectionSeconds)})`, durationSeconds: selectionSeconds },
        async ({ ffmpeg, inputPath, onProgress }) => {
          try {
            const args = buildExportArgs({
              segment: { start: region.start, duration: selectionSeconds },
              inputName: inputPath,
              outputName: virtualName,
              formatId: format.id,
              bitrateKbps: exportBitrate,
              fastCopy: copy,
              // Micro-fade anti-click sui confini A-B (20ms, inudibile come dissolvenza).
              fadeSeconds: copy ? 0 : 0.02,
            });
            const result = await runFfmpeg(ffmpeg, args, { durationSeconds: selectionSeconds, onProgress });
            if (result.exitCode !== 0) {
              throw new Error(describeFfmpegFailure(result.tailText) || 'Export selezione non riuscito.');
            }
            const data = await ffmpeg.readFile(virtualName);
            return new Blob([data], { type: format.mime });
          } finally {
            await safeDelete(ffmpeg, virtualName);
          }
        },
      );
      downloadBlob(blob, `${sanitizeFileName(effectiveBaseName)} - selezione${format.extension}`);
      setStatusText(`Selezione esportata (${formatBytes(blob.size)}).`);
      flashDone('Selezione A-B scaricata', formatBytes(blob.size));
    } catch (error) {
      if (error?.cancelled) {
        setStatusText('Export della selezione annullato.');
        return;
      }
      console.error(error);
      setErrorText(failureMessage(error, 'Export selezione non riuscito.'));
    }
  }

  async function processAndDownload() {
    if (isBusyRef.current) {
      return;
    }
    if (!audioFile || plan.error || plan.segments.length < 2) {
      setErrorText(plan.error || 'Definisci almeno due parti prima di esportare.');
      return;
    }

    const format = getExportFormat(effectiveFormatId);
    const outputExtension = format.extension;
    // Copia senza ricodifica solo se il container lo permette DAVVERO (evita MP3 in .m4a corrotti).
    const jobFastCopy = effectiveFastCopy && canFastCopy({ formatId: format.id, sourceExtension: audioFile.extension });

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
    waveformRef.current?.pause?.();

    // Snapshot del job. Il flag sync chiude la race con analyzeFile (che controlla il ref).
    isBusyRef.current = true;
    const jobAudio = audioFileRef.current ?? audioFile;
    const jobSegments = plan.segments.map((segment) => ({ ...segment }));
    const jobBaseName = effectiveBaseName;
    const jobFormatId = format.id;
    const jobBitrate = exportBitrate;
    const jobFade = jobFastCopy ? 0 : fadeSeconds;
    const speedKey = exportSpeedKey({ fastCopy: jobFastCopy, formatId: jobFormatId });
    const modeLabel = jobFastCopy
      ? `${format.label} · qualità originale`
      : `${format.label}${format.bitrates.length ? ` ${jobBitrate}k` : ''}`;
    const jobNames = jobSegments.map((segment) => buildSegmentFileName(
      jobBaseName,
      segment.index,
      outputExtension,
      segmentNames[segment.index] ?? '',
    ));
    const totalSeconds = jobSegments.reduce((sum, segment) => sum + segment.duration, 0);
    const totalEstimate = jobFastCopy
      // In copia il peso è quello della sorgente, non del bitrate scelto.
      ? Math.round((jobAudio.size || 0) * (totalSeconds / Math.max(1, jobAudio.duration || totalSeconds)))
      : jobSegments.reduce(
        (sum, segment) => sum + estimateExportBytes({
          durationSeconds: segment.duration,
          bitrateKbps: jobBitrate,
          formatId: jobFormatId,
        }),
        0,
      );

    const capabilities = getExportCapabilities();
    const advice = adviseExportStrategy({
      fileSizeBytes: jobAudio.size ?? 0,
      totalEstimateBytes: totalEstimate,
      segmentCount: jobSegments.length,
      capabilities,
      preference: exportDest,
    });
    // Su iPhone/iPad i download multipli sono bloccati (1 per gesto): un unico ZIP.
    const deviceMode = resolveExportModeForDevice(advice.mode);
    const destMode = deviceMode.mode;
    setAdvisorNote([...advice.reasons, ...advice.warnings, ...(deviceMode.note ? [deviceMode.note] : [])].join(' '));
    // Trattiene i Blob per il re-download solo sotto soglia: sopra, solo metadati.
    // Su mobile la soglia è molto più bassa (i Blob trattengono RAM per l'intera sessione).
    const retainBlobs = totalEstimate <= (isMobileDevice() ? 30 * 1024 * 1024 : RETAIN_BLOBS_BYTES);

    // Gli handle disco vanno chiesti NEL gesto utente, prima del lavoro pesante.
    let dirHandle = null;
    let zipFileHandle = null;
    try {
      if (destMode === 'folder') {
        if (typeof window.showDirectoryPicker !== 'function') {
          throw new Error('Scrittura su cartella non supportata da questo browser. Scegli un’altra destinazione.');
        }
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } else if (destMode === 'zip-stream') {
        if (typeof window.showSaveFilePicker !== 'function') {
          throw new Error('Salvataggio diretto non supportato da questo browser. Scegli un’altra destinazione.');
        }
        zipFileHandle = await window.showSaveFilePicker({
          suggestedName: `${sanitizeFileName(jobBaseName)} - ${jobSegments.length} parti.zip`,
          types: [{ description: 'Archivio ZIP', accept: { 'application/zip': ['.zip'] } }],
        });
      }
    } catch (pickerError) {
      isBusyRef.current = false;
      if (pickerError?.name === 'AbortError') {
        setStatusText(destMode === 'folder' ? 'Scelta cartella annullata.' : 'Salvataggio annullato.');
        return;
      }
      setErrorText(
        pickerError?.name === 'SecurityError' || pickerError?.name === 'NotAllowedError'
          ? 'Il browser ha bloccato la finestra di salvataggio: premi di nuovo «Taglia e scarica».'
          : pickerError?.message || 'Non riesco ad aprire la destinazione scelta.',
      );
      return;
    }

    const partStates = jobSegments.map(() => 'todo');
    const startedAt = Date.now();
    setIsBusy(true);
    setIsExporting(true);
    exportAbortRef.current = false;
    setExportDetail({
      active: true,
      stage: 'engine',
      segIndex: 0,
      segCount: jobSegments.length,
      frac: 0,
      doneSeconds: 0,
      totalSeconds,
      speed: 0,
      etaMs: null,
      bytesDone: 0,
      parts: [...partStates],
      startedAt,
      modeLabel,
      destMode,
    });
    const destLabel = destMode === 'folder'
      ? 'nella cartella scelta'
      : destMode === 'zip-stream'
        ? 'in uno ZIP su disco'
        : destMode === 'zip-classic'
          ? 'in un unico ZIP'
          : 'come file singoli';
    setStatusText(`Creo ${jobSegments.length} parti in ${modeLabel} ${destLabel}…`);

    const runPrefix = `segment-${Date.now()}`;
    let ffmpeg = null;
    const createdVirtualNames = [];
    let zipWriter = null;
    let zipWritable = null;
    let engineCrashed = false;

    const gate = createAbortGate();
    exportGateRef.current = gate;
    exportStageRef.current = 'engine';
    try {
      ffmpeg = await Promise.race([ensureEngineReady(), gate.promise]);
      if (exportAbortRef.current) {
        throw new Error('Export annullato.');
      }
      exportStageRef.current = 'segments';
      const inputPath = await ensureInputMounted(ffmpeg, jobAudio);
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

      const workStartedAt = performance.now();
      let doneSeconds = 0;
      let workedSeconds = 0;
      let bytesDone = 0;
      let lastPublishAt = 0;
      const publish = (index, segFrac, segDuration, force = false) => {
        const now = performance.now();
        if (!force && now - lastPublishAt < 200) {
          return;
        }
        lastPublishAt = now;
        const processed = workedSeconds + segDuration * segFrac;
        const speed = speedFactor(processed, now - workStartedAt);
        const frac = combineSecondsProgress({ doneSeconds, segSeconds: segDuration, segFrac, totalSeconds });
        const remainingSeconds = Math.max(0, totalSeconds - doneSeconds - segDuration * segFrac);
        const etaMs = etaMsFromSpeed({ remainingSeconds, speed });
        setExportDetail((previous) => previous?.active
          ? {
            ...previous,
            stage: 'segments',
            segIndex: index,
            frac,
            doneSeconds,
            speed,
            etaMs,
            bytesDone,
            parts: [...partStates],
          }
          : previous);
      };

      for (let index = 0; index < jobSegments.length; index += 1) {
        if (exportAbortRef.current) {
          throw new Error('Export annullato.');
        }
        const segment = jobSegments[index];
        const downloadName = jobNames[index];
        const virtualName = buildVirtualSegmentName(runPrefix, index, outputExtension);
        partStates[index] = 'active';
        publish(index, 0, segment.duration, true);

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
              partStates[index] = 'skipped';
              doneSeconds += segment.duration;
              publish(index, 0, 0, true);
              await yieldToUI();
              continue;
            }
          } catch {
            // file assente: si esporta normalmente
          }
        }

        const args = buildExportArgs({
          segment,
          inputName: inputPath,
          outputName: virtualName,
          formatId: format.id,
          bitrateKbps: jobBitrate,
          fastCopy: jobFastCopy,
          fadeSeconds: jobFade,
        });

        // Avanzamento intra-segmento reale (secondi di output scritti da ffmpeg).
        let result;
        try {
          result = await runFfmpeg(ffmpeg, args, {
            durationSeconds: segment.duration,
            onProgress: (frac) => publish(index, frac ?? 0, segment.duration),
          });
        } catch (execError) {
          if (!exportAbortRef.current) {
            // Il worker è morto (OOM, abort wasm): va ricreato al prossimo uso.
            engineCrashed = true;
          }
          const failed = new Error(
            exportAbortRef.current
              ? 'Export annullato.'
              : describeFfmpegFailure(execError?.message) || `Il motore si è fermato alla parte ${index + 1}. Riprova: riparte da capo in pochi secondi.`,
          );
          failed.failedIndex = index;
          throw failed;
        }

        if (exportAbortRef.current) {
          throw new Error('Export annullato.');
        }

        if (result.exitCode !== 0) {
          // Il segmento parziale resterebbe orfano nella FS: eliminalo subito.
          await safeDelete(ffmpeg, virtualName);
          const reason = describeFfmpegFailure(result.tailText);
          const failed = new Error(
            `Non sono riuscito a esportare la parte ${index + 1} in ${format.label}.${reason ? ` ${reason}` : ''}`,
          );
          failed.failedIndex = index;
          throw failed;
        }

        createdVirtualNames.push(virtualName);

        let outputData = await ffmpeg.readFile(virtualName);
        // Libera SUBITO il segmento dalla memoria wasm: mai più di uno in RAM.
        await safeDelete(ffmpeg, virtualName);
        createdVirtualNames.pop();

        if (destMode === 'folder') {
          const fileHandle = await dirHandle.getFileHandle(downloadName, { create: true });
          // Scrittura diretta dei byte: niente Blob intermedio da ~1 segmento.
          await writeBlobToFileHandle(fileHandle, outputData);
          exportedParts.push({ name: downloadName, size: outputData.length, duration: segment.duration });
        } else if (destMode === 'zip-stream' || destMode === 'zip-classic') {
          await zipWriter.add(downloadName, outputData);
          exportedParts.push({ name: downloadName, size: outputData.length, duration: segment.duration });
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

        bytesDone += outputData.length;
        outputData = null;
        doneSeconds += segment.duration;
        workedSeconds += segment.duration;
        partStates[index] = 'done';
        publish(Math.min(index + 1, jobSegments.length - 1), 0, 0, true);
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

      const workMs = performance.now() - workStartedAt;
      if (workedSeconds > 0) {
        rememberSpeed(speedKey, speedFactor(workedSeconds, workMs));
      }

      let zipUrl = null;
      let zipName = '';
      if (destMode === 'zip-stream' || destMode === 'zip-classic') {
        setExportDetail((previous) => previous?.active
          ? {
            ...previous,
            stage: 'finalizing',
            frac: 1,
            parts: [...partStates],
            finalizingLabel: destMode === 'zip-stream' ? 'Chiudo lo ZIP su disco…' : 'Creo lo ZIP da scaricare…',
          }
          : previous);
      }
      if (destMode === 'zip-stream') {
        await zipWriter.close();
        zipWriter = null;
        zipName = `${sanitizeFileName(jobBaseName)} - ${exportedParts.length} parti.zip`;
      } else if (destMode === 'zip-classic') {
        const zipBlob = await zipWriter.close();
        zipWriter = null;
        zipName = `${sanitizeFileName(jobBaseName)} - ${exportedParts.length} parti.zip`;
        const url = URL.createObjectURL(zipBlob);
        lastResultUrlsRef.current.push(url);
        zipUrl = url;
        downloadBlob(zipBlob, zipName);
      }

      clearCheckpoint();
      const elapsedLabel = formatDurationShort((Date.now() - startedAt) / 1000);
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
        elapsedLabel,
      });
      setStatusText(
        (destMode === 'folder'
          ? `Fatto in ${elapsedLabel}. ${exportedParts.length} parti scritte nella cartella scelta.`
          : destMode === 'zip-stream'
            ? `Fatto in ${elapsedLabel}. ZIP scritto su disco con ${exportedParts.length} parti.`
            : destMode === 'zip-classic'
              ? `Fatto in ${elapsedLabel}. ZIP scaricato con ${exportedParts.length} parti.${retainBlobs ? ' I singoli restano riscaricabili sotto.' : ''}`
              : `Fatto in ${elapsedLabel}. Ho scaricato ogni parte come file ${format.label} già rinominato.${retainBlobs ? '' : ' (Re-download disattivato per risparmiare memoria.)'}`),
      );
      flashDone(
        `Fatto in ${elapsedLabel}: ${exportedParts.length} parti ${destMode === 'folder' ? 'nella cartella' : destMode === 'singles' ? 'scaricate' : 'nello ZIP'}`,
        `${format.label}${jobFastCopy ? ' · qualità originale' : ''} · ${formatBytes(exportedParts.reduce((sum, part) => sum + (part.size || 0), 0))}`,
      );
      setTechnicalLog(
        `Export ${format.id} ${jobFastCopy ? 'senza ricodifica' : format.bitrates.length ? `${jobBitrate}k` : 'lossless'}${jobFade ? ` fade ${jobFade}s` : ''} via ${destMode}: ${exportedParts.length} file, ${formatSpeedFactor(speedFactor(workedSeconds, workMs)) ?? '—'} tempo reale.`,
      );
    } catch (error) {
      console.error(error);
      const cancelled = exportAbortRef.current || error?.message === 'Export annullato.';
      for (const url of lastResultUrlsRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      lastResultUrlsRef.current = [];
      if (cancelled) {
        setErrorText('');
        setFailedExportIndex(null);
        setStatusText('Export annullato. Puoi rilanciarlo quando vuoi.');
      } else {
        if (Number.isInteger(error?.failedIndex)) {
          setFailedExportIndex(error.failedIndex);
        }
        setErrorText(failureMessage(error, 'Non sono riuscito a esportare le parti.'));
        setStatusText('Esportazione non completata.');
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
      } else if (zipWritable) {
        // createZipStreamWriter ha fallito dopo createWritable: sblocca il file.
        try {
          await zipWritable.abort();
        } catch {
          // ignore
        }
      }
      if (ffmpeg && !engineCrashed && !exportAbortRef.current) {
        for (const virtualName of createdVirtualNames) {
          await safeDelete(ffmpeg, virtualName);
        }
      }
      if (engineCrashed) {
        resetAfterAbort();
      }

      exportAbortRef.current = false;
      exportGateRef.current = null;
      exportStageRef.current = '';
      setExportDetail(null);
      isBusyRef.current = false;
      setIsBusy(false);
      setIsExporting(false);
    }
  }

  const canExport = Boolean(audioFile) && !plan.error && plan.segments.length >= 2 && !isBusy;
  const activeStep = !audioFile ? 0 : (plan.error || plan.segments.length < 2 ? 1 : (!lastResult ? 2 : 3));
  const effectiveFormat = getExportFormat(effectiveFormatId);
  const formatBadge = effectiveFastCopy ? `${effectiveFormat.label} originale` : effectiveFormat.label;
  const helperChips = [
    'Locale nel browser',
    'Nessun upload',
    effectiveFastCopy ? 'Taglio senza ricodifica' : `Export ${effectiveFormat.label}`,
  ];

  // Stima PRIMA dell'export: secondi di audio / velocità (misurata su questo
  // dispositivo dopo il primo export, prudente prima) + motore se manca.
  const exportEstimate = useMemo(() => {
    if (!audioFile || plan.segments.length < 2) {
      return null;
    }
    const totalSeconds = plan.segments.reduce((sum, segment) => sum + segment.duration, 0);
    const { speed, measured } = expectedSpeed(exportSpeedKey({ fastCopy: effectiveFastCopy, formatId: effectiveFormatId }));
    const workSeconds = totalSeconds / speed + plan.segments.length * 0.15;
    const engineMissing = engineInfo.phase !== 'ready';
    const label = workSeconds < 8 ? 'pochi secondi' : `~${formatDurationShort(workSeconds)}`;
    return {
      workSeconds,
      measured,
      engineMissing,
      label,
      text: `${measured ? 'Tempo stimato' : 'Stima'}: ${label}${engineMissing ? ' + download motore (solo la prima volta)' : ''}`,
    };
  }, [audioFile, plan.segments, effectiveFastCopy, effectiveFormatId, engineInfo.phase]);

  // Una sola "attività in corso" alla volta nel dock fisso, con priorità:
  // export > operazioni del motore > caricamento bloccante.
  const activity = (() => {
    if (exportDetail?.active) {
      const engine = exportDetail.stage === 'engine' && engineInfo.phase !== 'ready' ? describeEngine(engineInfo) : null;
      const speed = formatSpeedFactor(exportDetail.speed);
      const eta = exportDetail.etaMs !== null && exportDetail.etaMs !== undefined
        ? formatDurationShort(exportDetail.etaMs / 1000)
        : null;
      const partNumber = Math.min(exportDetail.segIndex + 1, exportDetail.segCount);
      return {
        title: engine
          ? engine.title
          : exportDetail.stage === 'finalizing'
            ? (exportDetail.finalizingLabel || 'Finalizzo lo ZIP…')
            : `Taglio ${exportDetail.segCount} parti · ${exportDetail.modeLabel}`,
        detail: engine
          ? engine.detail
          : exportDetail.stage === 'finalizing'
            ? `${exportDetail.segCount} parti pronte`
            : [`Parte ${partNumber} di ${exportDetail.segCount}`, speed ? `${speed} tempo reale` : null, eta ? `restano ~${eta}` : null]
              .filter(Boolean).join(' · '),
        frac: engine ? engine.frac : exportDetail.stage === 'finalizing' ? null : exportDetail.frac,
        startedAt: exportDetail.startedAt,
        onCancel: handleCancelExport,
        cancelLabel: 'Annulla export',
        hint: 'puoi cambiare scheda, tienila aperta',
      };
    }
    if (task) {
      // Motore già pronto: la fase "engine" dura un attimo, mostra il compito vero.
      const engine = task.stage === 'engine' && engineInfo.phase !== 'ready' ? describeEngine(engineInfo) : null;
      const speed = formatSpeedFactor(task.speed);
      const eta = task.etaMs !== null && task.etaMs !== undefined ? formatDurationShort(task.etaMs / 1000) : null;
      return {
        title: engine ? engine.title : task.title,
        detail: engine
          ? engine.detail
          : task.detail || [
            Number.isFinite(task.processedSeconds) ? `${formatClock(task.processedSeconds)} elaborati` : 'Avvio…',
            speed ? `${speed} tempo reale` : null,
            eta ? `restano ~${eta}` : null,
          ].filter(Boolean).join(' · '),
        frac: engine ? engine.frac : task.frac,
        startedAt: task.startedAt,
        onCancel: task.cancellable === false ? null : handleCancelTask,
        hint: task.hint,
      };
    }
    // Il caricamento rapido (metadati, < 1 s) resta nella barra in linea: il dock
    // compare solo per le fasi lunghe (motore, analisi) dei formati non letti dal browser.
    if (loadJob?.active && (loadJob.stage === 'engine' || loadJob.stage === 'analysis')) {
      const engine = loadJob.stage === 'engine' ? describeEngine(engineInfo) : null;
      return {
        title: engine ? engine.title : loadJob.stage === 'analysis' ? 'Analizzo il file' : `Apro ${loadJob.fileName}`,
        detail: engine ? engine.detail : loadJob.fileName,
        frac: engine ? engine.frac : null,
        startedAt: loadJob.startedAt,
        onCancel: handleCancelAnalysis,
      };
    }
    return null;
  })();

  const showStickyCta = Boolean(audioFile) && canExport && !isExporting && !activity && !doneNote;
  const deviceLoadLimit = mobileLoadLimitBytes();

  return (
    <div className={`shell${showStickyCta || activity || doneNote ? ' shell-has-cta' : ''}`}>
      <div className="aurora aurora-left" />
      <div className="aurora aurora-right" />

      {swWaiting ? (
        <div className="update-banner" role="status">
          <strong>Nuova versione disponibile.</strong>
          <span>Ricarica per aggiornarla (fallo a lavoro finito).</span>
          <button
            type="button"
            className="mini-button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('app-sw-skip'));
              setSwWaiting(false);
            }}
          >
            Ricarica ora
          </button>
        </div>
      ) : null}

      <header className={`topbar${audioFile ? ' topbar-compact' : ''}`}>
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

          <div className="capture-switcher" role="toolbar" aria-label="Sorgente audio">
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
              {projectsError ? <p className="error-text" role="alert">{projectsError}</p> : null}
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
                className="sr-only"
                aria-label="Scegli un file audio"
              />
              <span className="dropzone-kicker">{isBusy ? 'Attendi…' : 'Trascina qui oppure tocca'}</span>
              <strong>{audioFile ? 'Carica un altro file audio' : 'Carica un file audio'}</strong>
              <p>
                MP3, M4A, WAV, OGG, FLAC, AAC, WMA, AIFF… Il file resta sul tuo dispositivo:
                nessun upload.
              </p>
              {Number.isFinite(deviceLoadLimit) ? (
                <span className="dropzone-limit">Su questo dispositivo fino a ~{Math.round(deviceLoadLimit / 1024 / 1024)} MB</span>
              ) : null}
            </label>
          ) : null}

          <div className="status-strip">
            <EngineChip
              engineInfo={engineInfo}
              onRetry={() => {
                ensureEngineReady().catch(() => {});
              }}
            />
            <p role="status" aria-live="polite">{statusText}</p>
          </div>

          {!audioFile && errorText ? <p className="error-text" role="alert">{errorText}</p> : null}

          {loadJob?.active ? (
            <LoadingBar
              job={loadJob}
              engineInfo={engineInfo}
              onCancel={handleCancelAnalysis}
            />
          ) : (
            <StepsBar activeStep={activeStep} />
          )}

          {audioFile ? (
            <div className="studio">
              <div className="studio-head">
                <div>
                  <p className="section-label">01 · Ascolta e segna</p>
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

              {audioFile.browserPlayable === false ? (
                <div className="native-preview">
                  <p className="native-note">
                    Il browser non sa riprodurre il formato {audioFile.formatLabel}. Puoi già tagliare
                    per tempi (mm:ss) o in parti uguali ed esportare in M4A/MP3; per ascoltare e usare
                    la forma d’onda crea un’anteprima leggera (l’export userà comunque l’originale).
                  </p>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleMakePlayablePreview}
                    disabled={isBusy}
                  >
                    Crea anteprima ascoltabile
                  </button>
                </div>
              ) : useNativePreview ? (
                <NativeAudioPreview
                  ref={waveformRef}
                  src={audioFile.objectUrl}
                  playbackRate={playbackRate}
                  onReady={handleWaveformReady}
                  onTimeUpdate={handleWaveformTimeUpdate}
                  onPlayStateChange={handleWaveformPlayStateChange}
                />
              ) : (
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
                  onLoadingProgress={handleWaveformProgress}
                  onWaveformError={handleWaveformError}
                  sampleRate={waveformRate}
                />
              )}
              {waveformError ? <p className="error-text" role="alert">{waveformError}</p> : null}
              <div role="timer" className="sr-only">
                {isPlaying ? 'In riproduzione' : 'In pausa'} {formatClock(currentTime)} di {formatClock(audioFile.duration)}
              </div>

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
                nativeMode={useNativePreview}
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
            <details className="advanced-disclosure">
              <summary>Pulizia audio professionale e capitoli automatici</summary>
              <AutomationPanel
                silenceThresholdDb={silenceThresholdDb}
                silenceMinDuration={silenceMinDuration}
                silenceMinSegment={silenceMinSegment}
                onSilenceThresholdChange={setSilenceThresholdDb}
                onSilenceDurationChange={setSilenceMinDuration}
                onSilenceMinSegmentChange={setSilenceMinSegment}
                onDetectSilences={handleDetectSilences}
                cleanupPreset={cleanupPreset}
                onCleanupPresetChange={(presetId) => {
                  setCleanupPreset(presetId);
                  setCleanupPreview(null);
                }}
                shortenPauses={shortenPauses}
                onShortenPausesChange={setShortenPauses}
                cleanupEstimateLabel={cleanupEstimateLabel}
                cleanupPreview={cleanupPreview}
                onCleanupPreview={handleCleanupPreview}
                onCloseCleanupPreview={() => setCleanupPreview(null)}
                onApplyCleanup={handleApplyCleanup}
                onRestoreOriginal={handleRestoreOriginal}
                hasOriginalBackup={Boolean(originalAudioBackup)}
                appliedCleanup={appliedCleanup}
                disabled={isBusy}
                lastDetectionSummary={lastDetectionSummary}
              />
            </details>
          ) : null}

          {audioFile ? (
            <div className="editor-grid">
              <div className="editor-column">
                <p className="section-label">02 · Definisci i tagli</p>
                <div className="mode-switch">
                <button
                  type="button"
                  className={mode === 'equal' ? 'mode-active' : ''}
                  aria-pressed={mode === 'equal'}
                  onClick={() => setMode('equal')}
                >
                  Parti uguali
                </button>
                <button
                  type="button"
                  className={mode === 'custom' ? 'mode-active' : ''}
                  aria-pressed={mode === 'custom'}
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
                        Nessun punto inserito. Premi «Usa la posizione corrente»,
                        doppio click sulla forma d’onda, oppure aggiungi un tempo manuale.
                      </p>
                    ) : null}

                    {customCuts.map((point, cutIndex) => {
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
                            aria-label={`Taglio ${cutIndex + 1} (mm:ss o secondi)`}
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
                            aria-label={`Regola taglio ${cutIndex + 1} in secondi`}
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
              onFastCopyChange={handleSpeedModeChange}
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
              exportDetail={exportDetail}
              engineInfo={engineInfo}
              naturalFormatId={naturalFormatId}
              effectiveFormatId={effectiveFormatId}
              exportEstimate={exportEstimate}
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

            {plan.error ? <p className="error-text" role="alert">{plan.error}</p> : null}
            {errorText ? <p className="error-text" role="alert">{errorText}</p> : null}

            <div className="summary-column summary-sub">
              <details className="advanced-disclosure">
                <summary>Progetto, JSON e trascrizione AI</summary>
                <div className="summary-sub-body">
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
                      className="sr-only"
                      aria-label="Importa progetto JSON"
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
              </details>
            </div>
            </div>
          </div>
        ) : (
          <p className="empty-text steps-hint">
            Carica un file audio per sbloccare i passi 2 e 3: ascolto, tagli e scaricamento.
          </p>
        )}
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
            <strong>M4A, MP3, OGG, WAV o FLAC a tua scelta.</strong>
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
          <p>
            <button
              type="button"
              className="mini-button"
              onClick={async () => {
                const confirmed = window.confirm(
                  'Pulire cache e ricaricare? Risolve versioni bloccate o file corrotti. I progetti salvati restano.',
                );
                if (confirmed) {
                  await hardResetApp();
                }
              }}
              title="Svuota le cache dell'app e ricarica (i progetti salvati restano)"
            >
              Problemi? Pulisci cache e ricarica
            </button>
          </p>
        </footer>
      </main>
      <StickyExportBar
        visible={showStickyCta}
        partsCount={plan.segments.length}
        formatLabel={formatBadge}
        speedHint={exportEstimate ? exportEstimate.label : ''}
        disabled={!canExport}
        onExport={processAndDownload}
      />
      <ActivityDock activity={activity} done={activity ? null : doneNote} />
    </div>
  );
}
