/**
 * Lettura file con progresso reale (bytes letti / totale).
 * Sostituisce fetchFile() opaco: niente FileReader senza progress,
 * una sola copia in RAM (trasferibile al worker via postMessage).
 */

export async function readFileBytesWithProgress(file, { onProgress, signal } = {}) {
  const total = Number(file?.size) || 0;
  const report = (loaded) => {
    try {
      onProgress?.(loaded, total);
    } catch {
      // il reporting non deve mai rompere la lettura
    }
  };

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DOMException('Lettura annullata', 'AbortError');
    }
  };

  if (typeof file?.stream === 'function' && total > 0) {
    const reader = file.stream().getReader();
    const chunks = [];
    let loaded = 0;
    try {
      for (;;) {
        throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength) {
          chunks.push(value);
          loaded += value.byteLength;
          report(loaded);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    throwIfAborted();
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    report(loaded);
    return out;
  }

  throwIfAborted();
  const buffer = await file.arrayBuffer();
  throwIfAborted();
  const out = new Uint8Array(buffer);
  report(out.byteLength);
  return out;
}
