/** Lifetime of one active screen wake lock effect. */
export function createWakeLockSession({ navigator = globalThis.navigator, onChange = () => {} } = {}) {
  let lock = null;
  let releaseListener = null;
  let disposed = false;
  let pending = false;

  const releaseQuietly = async (sentinel) => {
    try {
      await sentinel.release();
    } catch {
      // Wake locks are optional; release can fail after browser revocation.
    }
  };

  const acquire = async () => {
    if (disposed || lock || pending || typeof navigator?.wakeLock?.request !== 'function') {
      return;
    }
    pending = true;
    try {
      const acquired = await navigator.wakeLock.request('screen');
      if (disposed) {
        await releaseQuietly(acquired);
        return;
      }
      lock = acquired;
      releaseListener = () => {
        if (disposed || lock !== acquired) {
          return;
        }
        acquired.removeEventListener?.('release', releaseListener);
        releaseListener = null;
        lock = null;
        onChange(false);
      };
      acquired.addEventListener?.('release', releaseListener);
      onChange(true);
    } catch {
      // Unsupported, hidden document, or denied by the browser.
    } finally {
      pending = false;
    }
  };

  const dispose = () => {
    disposed = true;
    const acquired = lock;
    lock = null;
    if (acquired) {
      acquired.removeEventListener?.('release', releaseListener);
      releaseListener = null;
      releaseQuietly(acquired);
    }
  };

  return { acquire, dispose };
}
