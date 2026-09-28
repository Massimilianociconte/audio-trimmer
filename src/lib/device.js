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
export const NATIVE_PREVIEW_DURATION_SECONDS = 30 * 60;

export function mobileLoadLimitBytes(env = globalThis) {
  if (!isMobileDevice(env)) {
    return Infinity;
  }
  if (isLowMemoryDevice(env) || isIOS(env)) {
    return MOBILE_LOAD_LIMIT_LOW_BYTES;
  }
  return MOBILE_LOAD_LIMIT_BYTES;
}

/**
 * La decodifica integrale per la waveform (PCM float = GB per ore di audio)
 * uccide la tab su mobile: sopra soglia si usa l'anteprima nativa leggera.
 */
export function shouldUseNativePreview({ sizeBytes = 0, durationSeconds = 0 } = {}, env = globalThis) {
  if (!isMobileDevice(env)) {
    return false;
  }
  if (Number.isFinite(sizeBytes) && sizeBytes > NATIVE_PREVIEW_SIZE_BYTES) {
    return true;
  }
  if (Number.isFinite(durationSeconds) && durationSeconds > NATIVE_PREVIEW_DURATION_SECONDS) {
    return true;
  }
  return false;
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
