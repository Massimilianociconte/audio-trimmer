/**
 * Gesti touch per la forma d'onda su iPad/tablet Android.
 *
 * Il doppio click non esiste col dito: il doppio tocco fa zoomare la pagina
 * e l'evento `dblclick` non arriva in modo affidabile. Il WaveformEditor
 * riconosce quindi il doppio tocco dai PointerEvent (solo touch/penna: il
 * mouse continua a usare il dblclick nativo, invariato).
 */

export const DOUBLE_TAP_MAX_DELAY_MS = 350;
export const DOUBLE_TAP_MAX_DISTANCE_PX = 48;

/** Due tocchi {x, y, time} sono un doppio tocco se vicini nel tempo e nello spazio. */
export function isDoubleTap(previous, next, {
  maxDelayMs = DOUBLE_TAP_MAX_DELAY_MS,
  maxDistancePx = DOUBLE_TAP_MAX_DISTANCE_PX,
} = {}) {
  if (!previous || !next) {
    return false;
  }
  const dt = Number(next.time) - Number(previous.time);
  if (!Number.isFinite(dt) || dt < 0 || dt > maxDelayMs) {
    return false;
  }
  const dx = Number(next.x) - Number(previous.x);
  const dy = Number(next.y) - Number(previous.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return false;
  }
  return dx * dx + dy * dy <= maxDistancePx * maxDistancePx;
}

/**
 * Esiste ALMENO un puntatore "grosso" (dito/penna), anche se quello primario
 * è fine (iPad con trackpad, tablet con mouse collegato). Diverso da
 * isCoarsePointer (puntatore primario): serve ad allargare le zone di presa
 * senza cambiare nulla per chi usa solo il mouse.
 */
export function isCoarsePointerAvailable(env = globalThis) {
  try {
    return Boolean(env?.matchMedia?.('(any-pointer: coarse)')?.matches);
  } catch {
    return false;
  }
}
