import { useEffect, useState } from 'react';
import { createWakeLockSession } from '../lib/wakeLock.js';

/**
 * Tiene lo schermo acceso durante le elaborazioni lunghe, finché la pagina
 * è visibile. Il browser può rilasciare il lock quando si cambia scheda.
 * Ritorna true quando il lock è attivo; il supporto è opzionale.
 */
export function useWakeLock(active) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    setHeld(false);
    if (!active) {
      return undefined;
    }
    const session = createWakeLockSession({ onChange: setHeld });
    session.acquire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        session.acquire();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      session.dispose();
    };
  }, [active]);

  return held;
}
