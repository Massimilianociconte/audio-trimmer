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
 * Dopo il caricamento di un file il motore (32MB) serve quasi sempre per
 * l'export: scaricarlo in background mentre l'utente ascolta e segna i tagli
 * nasconde l'attesa. Mai su Risparmio dati o reti 2G.
 */
export function shouldWarmEngineInBackground(env = globalThis) {
  return !isSaveData(env) && !isSlowConnection(env);
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
 * Il preload del wasm (31MB + compilazione) al boot è la causa n.1 dei crash
 * "dopo pochi secondi" su mobile: va fatto solo su desktop con rete normale.
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
 * Limite oltre il quale rifiutiamo il caricamento PRIMA di copiare in RAM/wasm,
 * con messaggio azionabile. Desktop resta senza limite rigido (warning 350MB in App).
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

export function mobileLoadLimitBytes(env = globalThis) {
  if (!isMobileDevice(env)) {
    return Infinity;
  }
  // Su Samsung/Android deviceMemory è spesso arrotondato: mai fidarsi per ALZARE i limiti.
  if (isLowMemoryDevice(env) || isIOS(env) || isAndroid(env)) {
    return MOBILE_LOAD_LIMIT_LOW_BYTES;
  }
  return MOBILE_LOAD_LIMIT_BYTES;
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
 * PCM del 62%: forma d'onda disponibile su lezioni ~2,7 volte più lunghe
 * prima di ripiegare sull'anteprima nativa. Browser che non accettano 3 kHz
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
