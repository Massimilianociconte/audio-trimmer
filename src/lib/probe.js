/**
 * Helper resilienti per la verifica della traccia audio.
 * Il bug di produzione "Nessuna traccia audio trovata" scattava per QUALSIASI
 * fallimento di ffprobe (exit !== 0, file -o mancante, readFile Uint8Array),
 * anche quando il browser aveva già validato una durata riproducibile.
 * Queste funzioni distinguono "probe inconclusiva" da "davvero senza audio".
 */

export function decodeProbeText(raw) {
  if (raw === null || raw === undefined) {
    return '';
  }
  if (typeof raw === 'string') {
    return raw;
  }
  // ffmpeg.wasm può restituire Uint8Array anche con encoding utf8
  // (fallback UMD / version mismatch): String(Uint8Array) darebbe "97,117,..."
  if (raw instanceof Uint8Array) {
    try {
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder().decode(raw);
      }
    } catch {
      // fallback sotto
    }
    try {
      let out = '';
      const chunk = 8192;
      for (let i = 0; i < raw.length; i += chunk) {
        out += String.fromCharCode(...raw.subarray(i, i + chunk));
      }
      return out;
    } catch {
      return '';
    }
  }
  if (raw instanceof ArrayBuffer) {
    try {
      return new TextDecoder().decode(new Uint8Array(raw));
    } catch {
      return '';
    }
  }
  try {
    return String(raw);
  } catch {
    return '';
  }
}

export function hasAudioStreamText(text) {
  return String(text ?? '').toLowerCase().includes('audio');
}

/**
 * Parsa il log di `ffmpeg -i <input>` (che esce sempre con codice != 0
 * quando non c'è output): cerca "Stream #...: Audio:" e "Duration:".
 * Ritorna { hasAudio, hasVideo, durationSeconds }.
 */
export function parseFfmpegInputLog(logText) {
  const text = String(logText ?? '');
  const hasAudio = /stream\s*#.*:\s*audio:/i.test(text);
  const hasVideo = /stream\s*#.*:\s*video:/i.test(text);

  let durationSeconds = NaN;
  const match = text.match(/duration:\s*(\d+):(\d+):([\d.]+)/i);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      durationSeconds = hours * 3600 + minutes * 60 + seconds;
    }
  }

  return { hasAudio, hasVideo, durationSeconds };
}

/**
 * Decisione centrale: accettiamo il file?
 * - ffprobeOk + hasAudio => accept (prova superata)
 * - ffprobeOk + !hasAudio => reject con "Nessuna traccia audio" (evidenza positiva)
 * - ffprobe inconclusiva => fallback su log ffmpeg -i:
 *   - log con Audio: => accept
 *   - log con Video ma senza Audio => reject
 *   - altrimenti se il browser ha già validato la durata => accept (warning, non blocco)
 *   - altrimenti reject con "Impossibile verificare"
 */
export function decideAudioAcceptance({
  ffprobeOk,
  ffprobeHasAudio,
  ffmpegLogHasAudio,
  ffmpegLogHasVideo,
  browserDurationOk,
}) {
  if (ffprobeOk) {
    if (ffprobeHasAudio) {
      return { accept: true, reason: 'ffprobe-audio' };
    }
    return {
      accept: false,
      reason: 'ffprobe-no-audio',
      error: 'Nessuna traccia audio trovata in questo file. Scegli un file audio valido.',
    };
  }

  if (ffmpegLogHasAudio) {
    return { accept: true, reason: 'ffmpeg-log-audio' };
  }

  if (ffmpegLogHasVideo && !ffmpegLogHasAudio) {
    return {
      accept: false,
      reason: 'ffmpeg-log-video-only',
      error: 'Nessuna traccia audio trovata in questo file. Scegli un file audio valido.',
    };
  }

  if (browserDurationOk) {
    return { accept: true, reason: 'browser-duration-fallback' };
  }

  return {
    accept: false,
    reason: 'probe-inconclusive',
    error: 'Impossibile verificare la traccia audio di questo file. Prova con un MP3 o WAV standard.',
  };
}

/**
 * Parsa l'output JSON di
 * `ffprobe -show_entries format=duration:stream=codec_type -of json`.
 * NB: ffprobe di ffmpeg.wasm 0.12 restituisce SEMPRE -1 anche quando riesce:
 * l'esito si giudica dal contenuto, mai dal codice di uscita.
 * Ritorna { ok, durationSeconds, hasAudio, hasVideo } (ok = JSON valido con stream).
 */
export function parseProbeJson(raw) {
  const empty = { ok: false, durationSeconds: NaN, hasAudio: false, hasVideo: false };
  const text = decodeProbeText(raw).trim();
  if (!text) {
    return empty;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return empty;
  }
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const types = streams.map((stream) => String(stream?.codec_type ?? '').toLowerCase());
  const duration = Number(data?.format?.duration);
  return {
    ok: streams.length > 0,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : NaN,
    hasAudio: types.includes('audio'),
    hasVideo: types.includes('video'),
  };
}
