/**
 * Lavoro in background su Chrome Android (telefoni e tablet).
 *
 * Chrome Android congela una pagina nascosta, worker compresi, dopo 1 minuto
 * (Chrome 139+); Android congela anche i processi in cache dopo pochi secondi.
 * Due eccezioni rendono possibile continuare:
 * - Blink non congela una pagina che sta riproducendo audio udibile
 *   (`PageSchedulerImpl::IsBackgrounded()`: `!IsAudioPlaying()`);
 * - un elemento audio di almeno 5 s fa comparire la notifica multimediale di
 *   Chrome, un servizio in primo piano che tiene vivo il processo.
 *
 * Per Chrome è «udibile» un'uscita sopra −72,25 dBFS
 * (`kSilenceThresholdDBFS`, services/audio/output_stream.cc). Il tono usato qui
 * è a 30 Hz e −50 dBFS di picco: ~20 dB sopra quella soglia, sotto la soglia
 * dell'udito a quella frequenza e fuori dalla risposta degli altoparlanti di
 * telefoni e tablet. La notifica mostra l'avanzamento ed è sempre visibile:
 * nulla gira di nascosto e dalla notifica si può mettere in pausa.
 *
 * iPad/iPhone e desktop non lo usano: comportamento invariato.
 */
import { isAndroid, isIOS } from './device.js';

export const CHROME_SILENCE_THRESHOLD_DBFS = -72.24719896;
export const KEEP_ALIVE_TONE = Object.freeze({ sampleRate: 8000, seconds: 10, frequency: 30, peakDbfs: -50 });
const METADATA_INTERVAL_MS = 4000;
const ACTIONS = ['play', 'pause', 'stop'];

export function canWorkInBackground(env = globalThis) {
  try {
    return isAndroid(env)
      && !isIOS(env)
      && typeof env?.Audio === 'function'
      && typeof env?.Blob === 'function'
      && typeof env?.URL?.createObjectURL === 'function';
  } catch {
    return false;
  }
}

/** WAV PCM 16 bit mono con un numero intero di periodi: il loop non ha scatti. */
export function buildKeepAliveWav({ sampleRate, seconds, frequency, peakDbfs } = KEEP_ALIVE_TONE) {
  const frames = Math.round(sampleRate * seconds);
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);
  const amplitude = 32767 * 10 ** (peakDbfs / 20);
  for (let i = 0; i < frames; i += 1) {
    view.setInt16(44 + i * 2, Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)), true);
  }
  return new Uint8Array(buffer);
}

/**
 * Stati: off → starting → running; running → interrupted (un'altra app prende
 * l'audio, cuffie scollegate, «pausa» dalla notifica) → resume; blocked se il
 * browser rifiuta di suonare; finished = lavoro finito, la notifica mostra
 * l'esito finché la pagina non torna visibile (clear). Non lancia mai.
 */
export function createBackgroundSession({ env = globalThis, onChange = () => {}, now = () => Date.now() } = {}) {
  let audio = null;
  let url = '';
  let state = 'off';
  let wanted = false;
  let ownPause = false;
  let lastMetaAt = -Infinity;
  let lastMetaKey = '';

  const mediaSession = (() => {
    try {
      return env?.navigator?.mediaSession ?? null;
    } catch {
      return null;
    }
  })();

  const setState = (next) => {
    if (state === next) return;
    state = next;
    try {
      onChange(next);
    } catch {
      // l'interfaccia non deve fermare il lavoro
    }
  };

  const setMetadata = ({ title = '', artist = '' } = {}) => {
    lastMetaKey = `${title}\u0000${artist}`;
    lastMetaAt = now();
    if (!mediaSession) return;
    try {
      const init = { title, artist, album: 'Audio Cutter' };
      mediaSession.metadata = typeof env.MediaMetadata === 'function' ? new env.MediaMetadata(init) : init;
    } catch {
      // metadati facoltativi
    }
  };

  const setPlaybackState = (value) => {
    if (!mediaSession) return;
    try {
      mediaSession.playbackState = value;
    } catch {
      // facoltativo
    }
  };

  const setHandlers = (handlers) => {
    if (!mediaSession?.setActionHandler) return;
    for (const action of ACTIONS) {
      try {
        mediaSession.setActionHandler(action, handlers?.[action] ?? null);
      } catch {
        // azione non supportata
      }
    }
  };

  const onPause = () => {
    if (ownPause || !wanted) return;
    // Pausa non chiesta da qui: un'altra app ha preso l'audio o le cuffie
    // sono state scollegate. Senza tono Chrome congelerà la pagina.
    setPlaybackState('paused');
    setState('interrupted');
  };
  const onPlaying = () => {
    if (wanted) setState('running');
  };

  const ensureAudio = () => {
    if (audio) return audio;
    const tone = buildKeepAliveWav();
    url = env.URL.createObjectURL(new env.Blob([tone], { type: 'audio/wav' }));
    audio = new env.Audio();
    audio.loop = true;
    audio.preload = 'auto';
    audio.src = url;
    audio.addEventListener('pause', onPause);
    audio.addEventListener('playing', onPlaying);
    return audio;
  };

  const play = () => {
    let element;
    try {
      element = ensureAudio();
    } catch {
      setState('blocked');
      return;
    }
    ownPause = false;
    setPlaybackState('playing');
    let attempt;
    try {
      attempt = element.play();
    } catch (error) {
      attempt = Promise.reject(error);
    }
    Promise.resolve(attempt).then(
      () => {
        if (wanted && element === audio) setState('running');
      },
      () => {
        if (wanted && element === audio) {
          setPlaybackState('paused');
          setState('blocked');
        }
      },
    );
  };

  const pauseOwn = () => {
    ownPause = true;
    try {
      audio?.pause();
    } catch {
      // già fermo
    }
  };

  function clear() {
    wanted = false;
    if (audio) {
      pauseOwn();
      try {
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('playing', onPlaying);
        audio.removeAttribute('src');
        audio.load();
      } catch {
        // elemento già rilasciato
      }
      audio = null;
    }
    if (url) {
      try {
        env.URL.revokeObjectURL?.(url);
      } catch {
        // ignore
      }
      url = '';
    }
    setHandlers(null);
    if (mediaSession) {
      try {
        mediaSession.metadata = null;
      } catch {
        // ignore
      }
    }
    setPlaybackState('none');
    lastMetaKey = '';
    lastMetaAt = -Infinity;
    setState('off');
  }

  function resume() {
    if (!wanted) return;
    setState('starting');
    play();
  }

  const pauseByUser = () => {
    if (!wanted) return;
    pauseOwn();
    setPlaybackState('paused');
    setState('interrupted');
  };

  function start(meta) {
    wanted = true;
    setMetadata(meta);
    setHandlers({ play: resume, pause: pauseByUser, stop: pauseByUser });
    setState('starting');
    play();
  }

  function update(meta, { force = false } = {}) {
    if (!wanted || !meta) return;
    const key = `${meta.title ?? ''}\u0000${meta.artist ?? ''}`;
    if (key === lastMetaKey) return;
    if (!force && now() - lastMetaAt < METADATA_INTERVAL_MS) return;
    setMetadata(meta);
  }

  function finish(meta) {
    if (state === 'off') return;
    wanted = false;
    pauseOwn();
    if (meta) setMetadata(meta);
    setPlaybackState('paused');
    // A lavoro finito «play» sulla notifica la chiude invece di far ripartire il tono.
    setHandlers({ play: clear, pause: clear, stop: clear });
    setState('finished');
  }

  return {
    start,
    update,
    resume,
    finish,
    clear,
    dispose: clear,
    state: () => state,
  };
}
