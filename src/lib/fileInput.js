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
    // Prealloca: evita il transiente 2x (chunks[] + out) che uccide i tablet.
    let out = null;
    let chunks = null;
    try {
      try {
        out = new Uint8Array(total);
      } catch {
        out = null;
      }
      chunks = out ? null : [];
      let loaded = 0;
      for (;;) {
        throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength) {
          if (out) {
            out.set(value.subarray(0, Math.min(value.byteLength, total - loaded)), loaded);
          } else {
            chunks.push(value);
          }
          loaded += value.byteLength;
          report(Math.min(loaded, total));
        }
      }
      throwIfAborted();
      if (out) {
        const exact = loaded === total ? out : out.slice(0, loaded);
        report(loaded);
        return exact;
      }
      const combined = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      report(loaded);
      return combined;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  throwIfAborted();
  const buffer = await file.arrayBuffer();
  throwIfAborted();
  const out = new Uint8Array(buffer);
  report(out.byteLength);
  return out;
}
