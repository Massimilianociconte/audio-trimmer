import { useEffect, useRef } from 'react';

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return target.isContentEditable === true;
}

export function useKeyboardShortcuts(handlers, { enabled = true } = {}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    function onKeyDown(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }

      const map = handlersRef.current ?? {};
      const key = event.key;

      if (key === ' ' || event.code === 'Space') {
        if (map.togglePlay) {
          event.preventDefault();
          map.togglePlay();
        }
        return;
      }

      if (key === 'ArrowLeft') {
        if (event.shiftKey && map.skipBack30) {
          event.preventDefault();
          map.skipBack30();
        } else if (!event.shiftKey && map.skipBack5) {
          event.preventDefault();
          map.skipBack5();
        }
        return;
      }

      if (key === 'ArrowRight') {
        if (event.shiftKey && map.skipForward30) {
          event.preventDefault();
          map.skipForward30();
        } else if (!event.shiftKey && map.skipForward5) {
          event.preventDefault();
          map.skipForward5();
        }
        return;
      }

      if (event.shiftKey) {
        return;
      }

      if (key === 'j' || key === 'J') {
        if (map.slowDown) {
          event.preventDefault();
          map.slowDown();
        }
        return;
      }

      if (key === 'l' || key === 'L') {
        if (map.speedUp) {
          event.preventDefault();
          map.speedUp();
        }
        return;
      }

      if (key === 'k' || key === 'K') {
        if (map.togglePlay) {
          event.preventDefault();
          map.togglePlay();
        }
        return;
      }

      if (key === 'c' || key === 'C') {
        if (map.addCutHere) {
          event.preventDefault();
          map.addCutHere();
        }
        return;
      }

      if (key === 'b' || key === 'B') {
        if (map.addBookmarkHere) {
          event.preventDefault();
          map.addBookmarkHere();
        }
        return;
      }

      if (key === 'a' || key === 'A') {
        if (map.setLoopStart) {
          event.preventDefault();
          map.setLoopStart();
        }
        return;
      }

      if (key === 'z' || key === 'Z') {
        if (map.setLoopEnd) {
          event.preventDefault();
          map.setLoopEnd();
        }
        return;
      }

      if (key === 'x' || key === 'X') {
        if (map.clearLoop) {
          event.preventDefault();
          map.clearLoop();
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

export const KEYBOARD_HINTS = [
  { keys: ['Spazio', 'K'], action: 'Play / Pausa' },
  { keys: ['←', '→'], action: 'Salta 5 secondi' },
  { keys: ['Shift', '+', '←/→'], action: 'Salta 30 secondi' },
  { keys: ['J', 'L'], action: 'Velocità -/+' },
  { keys: ['C'], action: 'Taglia qui' },
  { keys: ['B'], action: 'Aggiungi segnalibro' },
  { keys: ['A', 'Z'], action: 'Loop A / B' },
  { keys: ['X'], action: 'Esci dal loop' },
];
