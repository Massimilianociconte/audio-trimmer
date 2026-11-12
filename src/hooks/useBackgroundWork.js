import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canWorkInBackground, createBackgroundSession } from '../lib/backgroundWork.js';

const PREF_KEY = 'audio-cutter-background-work';
// A lavoro finito con l'app nascosta il tono resta qualche secondo: i download
// finali e i salvataggi partono prima che Chrome possa congelare la pagina.
const LINGER_MS = 5000;
const DEFAULT_OUTCOME = { title: 'Lavoro terminato', artist: 'Apri Audio Cutter' };

function readPref() {
  try {
    return globalThis.localStorage?.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * Lavoro in background su Chrome Android (lib/backgroundWork.js): durante
 * `active` suona il tono che tiene viva la pagina e la notifica multimediale
 * mostra `meta`. Ovunque altro non fa nulla (supported = false).
 */
export function useBackgroundWork({ active, meta, outcomeRef }) {
  const supported = useMemo(() => canWorkInBackground(), []);
  const [enabled, setEnabledState] = useState(readPref);
  const [state, setState] = useState('off');
  const sessionRef = useRef(null);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const activeRef = useRef(active);
  activeRef.current = active;

  const getSession = useCallback(() => {
    if (!sessionRef.current) {
      sessionRef.current = createBackgroundSession({ onChange: setState });
    }
    return sessionRef.current;
  }, []);

  useEffect(() => {
    if (!supported) {
      return undefined;
    }
    const session = getSession();
    const current = session.state();
    if (active && enabled) {
      if (current === 'off' || current === 'finished') {
        session.start(metaRef.current);
      }
      return undefined;
    }
    if (active) {
      // Disattivato dall'utente durante il lavoro.
      if (current !== 'off') session.clear();
      return undefined;
    }
    if (current === 'off' || current === 'finished') {
      return undefined;
    }
    if (document.visibilityState === 'visible') {
      session.clear();
      return undefined;
    }
    const timer = window.setTimeout(() => {
      session.finish(outcomeRef?.current ?? DEFAULT_OUTCOME);
    }, LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [supported, active, enabled, getSession, outcomeRef]);

  const title = meta?.title ?? '';
  const artist = meta?.artist ?? '';
  useEffect(() => {
    if (supported && active && enabled) {
      sessionRef.current?.update({ title, artist });
    }
  }, [supported, active, enabled, title, artist]);

  useEffect(() => {
    if (!supported) {
      return undefined;
    }
    // Tornati nell'app a lavoro finito: la notifica con l'esito non serve più.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || activeRef.current) return;
      const session = sessionRef.current;
      if (session && session.state() !== 'off') session.clear();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [supported]);

  useEffect(() => () => sessionRef.current?.dispose(), []);

  const setEnabled = useCallback((value) => {
    setEnabledState(Boolean(value));
    try {
      globalThis.localStorage?.setItem(PREF_KEY, value ? 'on' : 'off');
    } catch {
      // preferenza solo per questa sessione
    }
  }, []);
  const resume = useCallback(() => {
    sessionRef.current?.resume();
  }, []);

  return { supported, enabled, setEnabled, state, resume };
}
