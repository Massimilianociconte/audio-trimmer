/**
 * Matematica pura per barre di avanzamento REALI.
 * Regola: ogni avanzamento deve venire da bytes/eventi misurati.
 * Quando non c'è misura, la UI mostra fase indeterminata (mai % inventate).
 */

// Fasi possibili del caricamento. Il percorso veloce (il browser legge il file)
// usa solo metadata → waveform; il motore entra in gioco solo se serve.
export const LOAD_STAGES = ['metadata', 'engine', 'analysis', 'waveform'];
export const FAST_LOAD_STAGES = ['metadata', 'waveform'];

// Pesi relativi: contano solo per combinare frazioni di fase già reali.
const LOAD_WEIGHTS = {
  metadata: 0.1,
  engine: 0.45,
  analysis: 0.15,
  waveform: 0.3,
};

export function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(1, Math.max(0, number));
}

export function loadStageIndex(stage, stages = LOAD_STAGES) {
  const index = stages.indexOf(stage);
  return index === -1 ? 0 : index;
}

/**
 * Frazione totale 0..1 del caricamento sulle fasi effettivamente usate.
 * stageFrac nullabile: fase indeterminata => base della fase (nessuna % finta).
 */
export function combineLoadProgress({ stage = 'metadata', stageFrac = null, stages = LOAD_STAGES } = {}) {
  const list = Array.isArray(stages) && stages.length > 0 ? stages : LOAD_STAGES;
  const totalWeight = list.reduce((sum, key) => sum + (LOAD_WEIGHTS[key] ?? 0), 0) || 1;
  let base = 0;
  for (const key of list) {
    if (key === stage) {
      break;
    }
    base += LOAD_WEIGHTS[key] ?? 0;
  }
  const weight = LOAD_WEIGHTS[stage] ?? 0;
  const frac = stageFrac === null || stageFrac === undefined ? 0 : clamp01(stageFrac);
  return clamp01((base + frac * weight) / totalWeight);
}

export function loadStageLabel(stage) {
  switch (stage) {
    case 'metadata':
      return 'Lettura file';
    case 'engine':
      return 'Motore di taglio';
    case 'analysis':
      return 'Analisi audio';
    case 'waveform':
      return 'Forma d’onda';
    default:
      return 'Caricamento';
  }
}

/**
 * Frazione totale 0..1 dell'export da bytes reali + avanzamento segmento corrente.
 */
export function combineExportProgress({ bytesDone = 0, segFrac = 0, segEstimate = 0, bytesTotal = 0 } = {}) {
  const total = Number(bytesTotal);
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  const done = Math.max(0, Number(bytesDone) || 0);
  const current = Math.max(0, Number(segEstimate) || 0) * clamp01(segFrac);
  return clamp01((done + current) / total);
}

/**
 * Frazione totale 0..1 misurata in SECONDI di audio elaborati:
 * indipendente dal bitrate stimato, quindi esatta anche col taglio senza ricodifica.
 */
export function combineSecondsProgress({ doneSeconds = 0, segSeconds = 0, segFrac = 0, totalSeconds = 0 } = {}) {
  const total = Number(totalSeconds);
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  const done = Math.max(0, Number(doneSeconds) || 0);
  const current = Math.max(0, Number(segSeconds) || 0) * clamp01(segFrac);
  return clamp01((done + current) / total);
}

/** Velocità di elaborazione in "× tempo reale" (secondi audio / secondi orologio). */
export function speedFactor(processedSeconds, elapsedMs) {
  const processed = Number(processedSeconds);
  const elapsedSec = Number(elapsedMs) / 1000;
  if (!Number.isFinite(processed) || processed <= 0 || !Number.isFinite(elapsedSec) || elapsedSec <= 0.2) {
    return 0;
  }
  return processed / elapsedSec;
}

/** ETA in ms dai secondi audio rimanenti e dalla velocità misurata. */
export function etaMsFromSpeed({ remainingSeconds = 0, speed = 0 } = {}) {
  const remaining = Number(remainingSeconds);
  const factor = Number(speed);
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(remaining) || remaining <= 0) {
    return null;
  }
  return Math.round((remaining / factor) * 1000);
}

export function throughputBytesPerSec(bytesDone, elapsedMs) {
  const elapsedSec = Number(elapsedMs) / 1000;
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) {
    return 0;
  }
  return Math.max(0, Number(bytesDone) || 0) / elapsedSec;
}

export function etaMsRemaining({ bytesDone = 0, bytesTotal = 0, throughputBps = 0 } = {}) {
  const remaining = Math.max(0, Number(bytesTotal) - Number(bytesDone));
  const speed = Number(throughputBps);
  if (!Number.isFinite(speed) || speed <= 0 || remaining <= 0) {
    return null;
  }
  return Math.round((remaining / speed) * 1000);
}

/** "00:35" / "02:10" per ETA, null se ignota. */
export function formatEtaClock(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) {
    return null;
  }
  const totalSec = Math.round(Number(ms) / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Durata leggibile e breve: "8 s", "1 min 20 s", "12 min". null se ignota. */
export function formatDurationShort(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  const total = Math.max(1, Math.round(value));
  if (total < 60) {
    return `${total} s`;
  }
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes >= 10 || rest === 0) {
    return `${Math.round(total / 60)} min`;
  }
  return `${minutes} min ${rest} s`;
}

/** "3,5×" / "120×" per la velocità di elaborazione. */
export function formatSpeedFactor(speed) {
  const value = Number(speed);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded).replace('.', ',')}×`;
}

// Righe emesse da `-progress pipe:1` (una chiave=valore per riga, terminate da \n):
// a differenza delle stats su stderr (terminate da \r e trattenute dal buffer
// TTY di Emscripten fino alla fine) arrivano in tempo reale.
const PROGRESS_KEY_LINE = /^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=\S*$/;

export function isFfmpegProgressLine(message) {
  return PROGRESS_KEY_LINE.test(String(message ?? '').trim());
}

/**
 * Secondi di output già scritti da una riga di `-progress`, null se la riga
 * non porta tempo. Nota: in FFmpeg anche out_time_ms è in microsecondi.
 */
export function parseFfmpegProgressSeconds(message) {
  const line = String(message ?? '').trim();
  let match = line.match(/^out_time_(?:us|ms)=(-?\d+)$/);
  if (match) {
    const micros = Number(match[1]);
    return Number.isFinite(micros) && micros >= 0 ? micros / 1e6 : null;
  }
  match = line.match(/^out_time=(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (match && !match[1]) {
    const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
    return Number.isFinite(seconds) ? seconds : null;
  }
  return null;
}
