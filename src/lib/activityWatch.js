/**
 * Scadenze che contano solo il tempo in cui la pagina lavora davvero.
 *
 * Su telefoni e tablet una scheda in background, un'altra app in primo piano o
 * lo schermo bloccato congelano JS e worker. I timer "a orologio" (setTimeout di
 * 120 s) scadevano tutti insieme al ritorno e uccidevano export e download sani
 * ("Il motore non risponde più"). Qui non contano:
 * - i momenti in cui la pagina è nascosta;
 * - i salti di orologio tra un tick e l'altro (pagina sospesa o timer strozzati).
 */
export function createActivityWatch({
  limitMs,
  onExpire,
  env = globalThis,
  tickMs,
  maxGapMs,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const tick = tickMs ?? Math.max(10, Math.min(1000, limitMs / 4));
  const gapLimit = maxGapMs ?? Math.max(5000, tick * 5);
  let idleMs = 0;
  let lastTick = now();
  let stopped = false;
  const isHidden = () => {
    try {
      return env?.document?.visibilityState === 'hidden';
    } catch {
      return false;
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer);
  };
  const timer = setIntervalFn(() => {
    if (stopped) return;
    const current = now();
    const gap = current - lastTick;
    lastTick = current;
    if (isHidden() || gap < 0 || gap > gapLimit) {
      return;
    }
    idleMs += gap;
    if (idleMs >= limitMs) {
      stop();
      onExpire?.();
    }
  }, tick);
  return {
    touch() {
      idleMs = 0;
    },
    stop,
  };
}

/** Come un timeout, ma scade solo dopo `ms` di tempo ATTIVO senza risposta. */
export function withActiveTimeout(promise, ms, message, options = {}) {
  let watch = null;
  const timeout = new Promise((_, reject) => {
    watch = createActivityWatch({
      ...options,
      limitMs: ms,
      onExpire: () => {
        const error = new Error(message);
        error.isTimeout = true;
        reject(error);
      },
    });
  });
  return Promise.race([promise, timeout]).finally(() => watch?.stop());
}
