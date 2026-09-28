/**
 * Matematica pura per barre di avanzamento REALI.
 * Regola: ogni avanzamento deve venire da bytes/eventi misurati.
 * Quando non c'è misura, la UI mostra fase indeterminata (mai % inventate).
 */

export const LOAD_STAGES = ['reading', 'engine', 'analysis', 'waveform'];

// Pesi di fallback: contano solo per combinare frazioni di fase già reali.
const LOAD_WEIGHTS = {
  reading: 0.3,
  engine: 0.3,
  analysis: 0.15,
  waveform: 0.25,
};

export function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(1, Math.max(0, number));
}

export function loadStageIndex(stage) {
  const index = LOAD_STAGES.indexOf(stage);
  return index === -1 ? 0 : index;
}

/**
 * Frazione totale 0..1 del caricamento.
 * stageFrac nullabile: fase indeterminata => base della fase (nessuna % finta).
 */
export function combineLoadProgress({ stage = 'reading', stageFrac = null } = {}) {
  let base = 0;
  for (const key of LOAD_STAGES) {
    if (key === stage) {
      break;
    }
    base += LOAD_WEIGHTS[key] ?? 0;
  }
  const weight = LOAD_WEIGHTS[stage] ?? 0;
  const frac = stageFrac === null || stageFrac === undefined ? 0 : clamp01(stageFrac);
  return clamp01(base + frac * weight);
}

export function loadStageLabel(stage) {
  switch (stage) {
    case 'reading':
      return 'Lettura file';
    case 'engine':
      return 'Motore locale';
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
