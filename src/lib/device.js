/**
 * Rilevamento dispositivo/rete per proteggere i mobile dal crash (OOM/jetsam).
 * Tutte le funzioni accettano override per i test e non lanciano mai
 * se window/navigator assenti (SSR, test Node).
 */

export function getUserAgent(env = globalThis) {
  try {
    return String(env?.navigator?.userAgent ?? '');
  } catch {
    return '';
  }
}

export function isIOS(env = globalThis) {
  const ua = getUserAgent(env);
  if (/iPad|iPhone|iPod/.test(ua)) {
    return true;
  }
  // iPadOS 13+ si presenta come Mac ma ha touch
  try {
    const platform = String(env?.navigator?.platform ?? '');
    const maxTouch = Number(env?.navigator?.maxTouchPoints ?? 0);
    if (/^Mac/.test(platform) && maxTouch > 1) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function isAndroid(env = globalThis) {
  return /Android/.test(getUserAgent(env));
}

export function isCoarsePointer(env = globalThis) {
  try {
    return Boolean(env?.matchMedia?.('(pointer: coarse)')?.matches);
  } catch {
    return false;
  }
}

export function isMobileDevice(env = globalThis) {
  return isCoarsePointer(env) || isIOS(env) || isAndroid(env);
}

export function isSaveData(env = globalThis) {
  try {
    return Boolean(env?.navigator?.connection?.saveData);
  } catch {
    return false;
  }
}

export function deviceMemoryGB(env = globalThis) {
  try {
    const value = Number(env?.navigator?.deviceMemory);
    return Number.isFinite(value) && value > 0 ? value : NaN;
  } catch {
    return NaN;
  }
}

export function cpuCores(env = globalThis) {
  try {
    const value = Number(env?.navigator?.hardwareConcurrency);
    return Number.isFinite(value) && value > 0 ? value : NaN;
  } catch {
    return NaN;
  }
}

export function isSlowConnection(env = globalThis) {
  try {
    const type = String(env?.navigator?.connection?.effectiveType ?? '');
    return type === '2g' || type === 'slow-2g';
  } catch {
    return false;
  }
}

/**
 * Su desktop adeguati anticipa il motore mentre si impostano i tagli.
 * Su mobile/PC deboli la compilazione e il worker hanno un costo residente
 * molto superiore ai 32 MB del download: attendi un'elaborazione esplicita.
 */
export function shouldWarmEngineInBackground(env = globalThis) {
  return !isMobileDevice(env) && !isLowMemoryDevice(env) && !isSaveData(env) && !isSlowConnection(env);
}

export function isLowMemoryDevice(env = globalThis) {
  const mem = deviceMemoryGB(env);
  if (Number.isFinite(mem) && mem <= 4) {
    return true;
  }
  const cores = cpuCores(env);
  if (Number.isFinite(cores) && cores <= 4) {
    return true;
  }
  return false;
}

/**
 * Il preload del wasm e della compilazione aumenta il picco residente:
 * al boot va fatto solo su desktop adeguati con rete normale.
 */
export function shouldPreloadEngine(env = globalThis) {
  if (isSaveData(env)) {
    return false;
  }
  if (isMobileDevice(env)) {
    return false;
  }
  if (isLowMemoryDevice(env)) {
    return false;
  }
  return true;
}

/**
 * Soglie storiche e guardie della forma d’onda. La selezione del File non
 * legge i byte; la copia di compatibilità ha un budget separato in memoryPolicy.
 */
export const MOBILE_LOAD_LIMIT_LOW_BYTES = 100 * 1024 * 1024;
export const MOBILE_LOAD_LIMIT_BYTES = 150 * 1024 * 1024;
export const NATIVE_PREVIEW_SIZE_BYTES = 80 * 1024 * 1024;
// La waveform decodifica a 8kHz (3kHz sui dispositivi deboli, vedi waveformSampleRate):
// PCM ≈ durata×frequenza×2ch×4B.
// Le soglie DEVONO misurarlo, non i byte compressi: 20min stereo ≈ 77MB di PCM.
export const NATIVE_PREVIEW_PCM_BYTES = 60 * 1024 * 1024;
export const DESKTOP_NATIVE_PREVIEW_SIZE_BYTES = 250 * 1024 * 1024;
export const DESKTOP_NATIVE_PREVIEW_PCM_BYTES = 400 * 1024 * 1024;
// PC di fascia bassa (≤4GB o ≤4 core): 400MB di PCM + canvas li mandano in swap.
export const LOW_END_DESKTOP_PREVIEW_PCM_BYTES = 160 * 1024 * 1024;

// File-backed input is safe to select; protect actual allocations instead.
// WORKERFS compatibility fallback has a separate hard copy budget.
export function mobileLoadLimitBytes() {
  return Infinity;
}

export const DEFAULT_WAVEFORM_SAMPLE_RATE = 8000;
export const LOW_WAVEFORM_SAMPLE_RATE = 3000;

function supportsAudioSampleRate(rate, env = globalThis) {
  try {
    const Ctx = env?.OfflineAudioContext || env?.webkitOfflineAudioContext;
    if (typeof Ctx !== 'function') {
      return false;
    }
    // eslint-disable-next-line no-new
    new Ctx(1, 1, rate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Frequenza a cui decodificare l'audio SOLO per disegnare la forma d'onda.
 * Su telefoni/tablet/PC deboli 3 kHz bastano per il disegno e tagliano il
 * PCM finale del 62%. Lo staging del decoder ha una guardia separata e può
 * richiedere l'anteprima nativa prima. Browser che non accettano 3 kHz
 * (es. Firefox) restano a 8 kHz; il WaveformEditor ripiega da solo se la
 * decodifica fallisse comunque.
 */
export function waveformSampleRate(env = globalThis) {
  if ((isMobileDevice(env) || isLowMemoryDevice(env)) && supportsAudioSampleRate(LOW_WAVEFORM_SAMPLE_RATE, env)) {
    return LOW_WAVEFORM_SAMPLE_RATE;
  }
  return DEFAULT_WAVEFORM_SAMPLE_RATE;
}

/** Stima del PCM che la waveform allocherebbe (stereo, float32, alla frequenza data). */
export function estimateWaveformBytes(durationSeconds, sampleRate = DEFAULT_WAVEFORM_SAMPLE_RATE) {
  const seconds = Number(durationSeconds);
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : DEFAULT_WAVEFORM_SAMPLE_RATE;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.round(seconds * rate * 2 * 4);
}

/**
 * La decodifica integrale per la waveform (PCM + canvas) uccide la tab:
 * sopra soglia si usa l'anteprima nativa leggera. La soglia è sul PCM stimato,
 * non sui byte compressi (un m4a da 14MB può valere centinaia di MB di PCM).
 */
export function shouldUseNativePreview({ sizeBytes = 0, durationSeconds = 0, sampleRate } = {}, env = globalThis) {
  const size = Number(sizeBytes) || 0;
  const pcm = estimateWaveformBytes(durationSeconds, sampleRate ?? waveformSampleRate(env));
  // Compressed ArrayBuffer, decoder working copy and PCM can coexist.
  // This is a conservative allocation estimate, not measured free RAM.
  // Chromium RSS profiling shows that decoder staging can exceed the final
  // resampled PCM by several times. Count two native-rate stereo workspaces
  // as well: lowering the WaveSurfer sample rate alone cannot bound this peak.
  const decoderPCM = estimateWaveformBytes(durationSeconds, 48000);
  const peak = 2 * size + 2 * pcm + 2 * decoderPCM;
  const peakLimit = (isMobileDevice(env) ? 128 : isLowMemoryDevice(env) ? 256 : 512) * 1024 * 1024;
  if (peak > peakLimit) return true;
  if (isMobileDevice(env)) {
    return size > NATIVE_PREVIEW_SIZE_BYTES || pcm > NATIVE_PREVIEW_PCM_BYTES;
  }
  // Anche i desktop muoiono su decode enormi: guardia assoluta, più bassa sui PC deboli.
  const pcmLimit = isLowMemoryDevice(env) ? LOW_END_DESKTOP_PREVIEW_PCM_BYTES : DESKTOP_NATIVE_PREVIEW_PCM_BYTES;
  return size > DESKTOP_NATIVE_PREVIEW_SIZE_BYTES || pcm > pcmLimit;
}

/**
 * iOS consente un solo download per gesto utente: la modalità "singles"
 * (N click programmatici) arriva a 1 parte e sembra "export rotto".
 */
export function resolveExportModeForDevice(mode, env = globalThis) {
  if (mode === 'singles' && isIOS(env)) {
    return {
      mode: 'zip-classic',
      note: 'Su iPhone/iPad uso un unico ZIP (iOS blocca i download multipli).',
    };
  }
  return { mode, note: '' };
}
