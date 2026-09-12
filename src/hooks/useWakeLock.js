import { useEffect, useRef, useState } from 'react';

/**
 * Tiene lo schermo/sistema sveglio durante le elaborazioni lunghe
 * (export, cleanup) così i progetti pesanti proseguono in background
 * anche a tab non in primo piano.
 * Ritorna true quando il lock è attivo. Fallisce silenziosamente
 * sui browser senza supporto.
 */
export function useWakeLock(active) {
  const [held, setHeld] = useState(false);
  const lockRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;

    const acquire = async () => {
      if (!activeRef.current || cancelled) {
        return;
      }
      try {
        const api = globalThis.navigator?.wakeLock;
        if (!api || typeof api.request !== 'function') {
          return;
        }
        if (lockRef.current) {
          return;
        }
        const lock = await api.request('screen');
        if (cancelled || !activeRef.current) {
          try {
            await lock.release();
          } catch {
            // ignore
          }
          return;
        }
        lockRef.current = lock;
        setHeld(true);
        lock.addEventListener?.('release', () => {
          lockRef.current = null;
          if (!cancelled) {
            setHeld(false);
          }
        });
      } catch {
        // permesso negato o non supportato: si prosegue senza lock
      }
    };

    const release = async () => {
      const lock = lockRef.current;
      lockRef.current = null;
      setHeld(false);
      if (lock) {
        try {
          await lock.release();
        } catch {
          // ignore
        }
      }
    };

    if (active) {
      acquire();
      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          acquire();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        cancelled = true;
        document.removeEventListener('visibilitychange', onVisibility);
        release();
      };
    }

    release();
    return undefined;
  }, [active]);

  return held;
}
