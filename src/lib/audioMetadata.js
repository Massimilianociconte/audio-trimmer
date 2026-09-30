export function readAudioDurationFromBrowser(objectUrl, mimeType = '', { signal, env = globalThis } = {}) {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException('Caricamento annullato.', 'AbortError');
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    // Skip immediato se il browser dichiara di non saper riprodurre il tipo:
    // evita 15s di timeout muto su Safari/iOS (opus/webm, wma, amr...).
    if (mimeType) {
      try {
        const probe = env.document.createElement('audio');
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

    const audio = env.document.createElement('audio');
    let settled = false;

    const timeoutId = env.setTimeout(() => {
      finalize(() => reject(new Error('Timeout metadata browser')));
    }, 15000);

    function finalize(callback) {
      if (settled) {
        return;
      }

      settled = true;
      env.clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      callback();
    }

    function handleAbort() {
      finalize(() => reject(aborted()));
    }
    signal?.addEventListener('abort', handleAbort, { once: true });

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
