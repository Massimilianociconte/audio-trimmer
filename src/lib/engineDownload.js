// Only the fixed-size engine is accumulated here, never user audio.
export async function downloadEngineWasm(url, {
  expectedBytes, onBytes = () => {}, signal, fetchImpl = globalThis.fetch,
  stallMs = 20000, maxAttempts = 3, retryDelayMs = 1000,
} = {}) {
  const chunks = [];
  let loaded = 0;
  let resumable = true;
  const abortError = () => signal?.reason ?? new DOMException('Download annullato', 'AbortError');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const cancel = () => controller.abort(abortError());
    signal?.addEventListener('abort', cancel, { once: true });
    let reader;
    let timer;
    const timed = async (operation) => {
      let rejectTimeout;
      const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
      const onAbort = () => rejectTimeout(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(new Error('Connessione in stallo durante il download del motore.')), stallMs);
      try {
        controller.signal.throwIfAborted();
        return await Promise.race([operation(), timeout]);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
      }
    };
    try {
      const response = await timed(() => fetchImpl(url, { headers: loaded ? { Range: `bytes=${loaded}-` } : {}, signal: controller.signal }));
      resumable = !response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity';
      if (!response.ok) throw new Error(`Download motore non riuscito (HTTP ${response.status}).`);
      if (response.status === 200 && loaded) { chunks.length = 0; loaded = 0; }
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== loaded || Number(range[3]) !== expectedBytes) {
          const error = new Error('Risposta Range non valida: ripresa del motore non sicura.');
          error.fatal = true; throw error;
        }
      }
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await timed(() => reader.read());
          if (done) break;
          if (!value?.byteLength) continue;
          loaded += value.byteLength;
          if (loaded > expectedBytes) { const error = new Error('Dimensione del motore scaricato non valida.'); error.fatal = true; throw error; }
          chunks.push(value);
          onBytes(loaded, expectedBytes);
        }
      } else {
        const blob = await timed(() => response.blob());
        chunks.push(blob); loaded += blob.size;
        onBytes(loaded, expectedBytes);
      }
      if (loaded !== expectedBytes) throw new Error('Motore scaricato incompleto. Controlla la connessione e riprova.');
      const blob = new Blob(chunks, { type: 'application/wasm' });
      chunks.length = 0;
      const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      if (magic[0] !== 0 || magic[1] !== 97 || magic[2] !== 115 || magic[3] !== 109) throw new Error('Motore scaricato corrotto. Pulisci la cache e riprova.');
      signal?.throwIfAborted();
      return blob;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error?.fatal || attempt === maxAttempts) throw error;
      if (!resumable) { chunks.length = 0; loaded = 0; }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* pending read */ }
      }
      signal?.removeEventListener('abort', cancel);
    }
    if (retryDelayMs) {
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(handle); reject(abortError()); };
        const handle = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, retryDelayMs * attempt);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }
}
