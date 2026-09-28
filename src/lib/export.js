import { normalizeExtension } from './segments.js';

export const EXPORT_FORMATS = {
  m4a: {
    id: 'm4a',
    label: 'M4A (AAC)',
    description: 'Leggero e compatibile. Ideale per lezioni e parlato.',
    extension: '.m4a',
    mime: 'audio/mp4',
    codec: 'aac',
    bitrates: [64, 96, 128, 192, 256],
    defaultBitrate: 128,
    supportsFastCopy: true,
    copyHint: 'Copia veloce solo se la sorgente è già AAC/M4A.',
    needsMovflags: true,
  },
  mp3: {
    id: 'mp3',
    label: 'MP3',
    description: 'Massima compatibilità con player e auto.',
    extension: '.mp3',
    mime: 'audio/mpeg',
    codec: 'libmp3lame',
    bitrates: [64, 96, 128, 192, 256, 320],
    defaultBitrate: 128,
    supportsFastCopy: true,
    copyHint: 'Copia veloce solo se la sorgente è già MP3.',
    needsMovflags: false,
  },
  wav: {
    id: 'wav',
    label: 'WAV',
    description: 'Senza perdita. File grandi, per editing successivo.',
    extension: '.wav',
    mime: 'audio/wav',
    codec: 'pcm_s16le',
    bitrates: [],
    defaultBitrate: 0,
    supportsFastCopy: false,
    copyHint: '',
    needsMovflags: false,
  },
  ogg: {
    id: 'ogg',
    label: 'OGG Vorbis',
    description: 'Open e leggero. Ottimo per web e archivio.',
    extension: '.ogg',
    mime: 'audio/ogg',
    codec: 'libvorbis',
    bitrates: [64, 96, 128, 192, 256],
    defaultBitrate: 128,
    supportsFastCopy: false,
    copyHint: '',
    needsMovflags: false,
  },
  flac: {
    id: 'flac',
    label: 'FLAC',
    description: 'Lossless compresso. Metà peso del WAV, qualità identica.',
    extension: '.flac',
    mime: 'audio/flac',
    codec: 'flac',
    bitrates: [],
    defaultBitrate: 0,
    supportsFastCopy: false,
    copyHint: '',
    needsMovflags: false,
  },
};

export const EXPORT_FORMAT_ORDER = ['m4a', 'mp3', 'ogg', 'wav', 'flac'];

export function getExportFormat(id) {
  return EXPORT_FORMATS[id] ?? EXPORT_FORMATS.m4a;
}

export function sanitizeFileName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'audio';
}

export function buildSegmentFileName(baseName, index, extension, customLabel = '') {
  const safeBase = sanitizeFileName(baseName);
  const safeLabel = String(customLabel ?? '').trim().slice(0, 60).replace(/[\\/:*?"<>|]/g, '');
  const ext = normalizeExtension(extension);
  if (safeLabel) {
    return `${safeBase} - ${String(index).padStart(2, '0')} - ${safeLabel}${ext}`;
  }
  return `${safeBase} - parte ${index}${ext}`;
}

export function formatFfmpegTime(seconds) {
  return Math.max(0, Number(seconds) || 0).toFixed(3);
}

function buildFadeFilter(duration, fadeSeconds) {
  const fade = Number(fadeSeconds) || 0;
  if (!(fade > 0) || !(duration > fade * 2)) {
    return '';
  }
  const safeFade = Math.min(fade, 5);
  return `afade=t=in:st=0:d=${safeFade},afade=t=out:st=${(duration - safeFade).toFixed(3)}:d=${safeFade}`;
}

/**
 * Costruisce gli argomenti ffmpeg per un singolo segmento.
 * - fastCopy: nessun re-encode (taglio keyframe, velocissimo ma meno preciso).
 * - altrimenti seek accurato dopo -i + re-encode + fade opzionale.
 */
export function buildExportArgs({
  segment,
  inputName,
  outputName,
  formatId = 'm4a',
  bitrateKbps = 128,
  fastCopy = false,
  fadeSeconds = 0,
}) {
  const format = getExportFormat(formatId);
  const start = formatFfmpegTime(segment.start);
  const length = formatFfmpegTime(segment.duration);

  if (fastCopy && format.supportsFastCopy) {
    // Copia pacchetti: nessuna ricodifica, qualità identica e decine di volte
    // più veloce. Precisione al frame (~23-26 ms per AAC/MP3). make_zero evita
    // timestamp negativi dopo il seek (player che sbagliano durata/inizio).
    const copyArgs = [
      '-hide_banner',
      '-nostats',
      '-y',
      '-ss', start,
      '-t', length,
      '-i', inputName,
      '-map', '0:a:0',
      '-vn',
      '-sn',
      '-c:a', 'copy',
      '-avoid_negative_ts', 'make_zero',
    ];
    if (format.needsMovflags) {
      copyArgs.push('-movflags', '+faststart');
    }
    copyArgs.push(outputName);
    return copyArgs;
  }

  const args = [
    '-hide_banner',
    '-nostats',
    '-y',
    '-ss', start,
    '-i', inputName,
    '-t', length,
    '-map', '0:a:0',
    '-vn',
    '-sn',
  ];

  const fadeFilter = buildFadeFilter(segment.duration, fadeSeconds);
  const filters = [];
  if (fadeFilter) {
    filters.push(fadeFilter);
  }

  if (format.id === 'wav') {
    // Dither triangolare col resampler integrato (sempre disponibile nel core wasm):
    // evita distorsione di quantizzazione su fade e code a basso livello
    // quando la sorgente è a profondità maggiore di 16 bit.
    filters.push('aresample=dither_method=triangular');
  }
  if (filters.length > 0) {
    args.push('-af', filters.join(','));
  }

  if (format.id === 'wav') {
    args.push('-c:a', format.codec);
  } else if (format.id === 'flac') {
    args.push('-c:a', format.codec, '-compression_level', '5');
  } else {
    const available = format.bitrates.length > 0 ? format.bitrates : [bitrateKbps];
    const nearest = available.reduce((best, candidate) =>
      Math.abs(candidate - bitrateKbps) < Math.abs(best - bitrateKbps) ? candidate : best,
    );
    args.push('-c:a', format.codec, '-b:a', `${nearest}k`);
    if (format.id === 'm4a') {
      // Coder AAC "fast": 2x più veloce del twoloop a 128k e ~9x a 256k
      // (misurato nel core wasm single-thread), differenza non udibile.
      args.push('-aac_coder', 'fast');
    }
  }

  if (format.needsMovflags) {
    args.push('-movflags', '+faststart');
  }

  args.push(outputName);
  return args;
}

/**
 * Formato di uscita in cui la sorgente si può tagliare SENZA ricodifica
 * (stesso codec/container), null se serve convertire.
 */
export function naturalCopyFormat(sourceExtension) {
  const src = String(sourceExtension || '').toLowerCase();
  if (src === '.mp3') {
    return 'mp3';
  }
  if (['.m4a', '.aac', '.mp4'].includes(src)) {
    return 'm4a';
  }
  return null;
}

export function canFastCopy({ formatId, sourceExtension }) {
  const format = getExportFormat(formatId);
  if (!format.supportsFastCopy) {
    return false;
  }
  const src = String(sourceExtension || '').toLowerCase();
  if (format.id === 'm4a') {
    return ['.m4a', '.aac', '.mp4'].includes(src);
  }
  if (format.id === 'mp3') {
    return ['.mp3'].includes(src);
  }
  return false;
}

export function estimateExportBytes({ durationSeconds, bitrateKbps, formatId }) {
  const format = getExportFormat(formatId);
  if (format.id === 'wav') {
    return Math.round(durationSeconds * 44100 * 2 * 2);
  }
  if (format.id === 'flac') {
    // Lossless compresso: ~55% del WAV per parlato/musica tipici.
    return Math.round(durationSeconds * 44100 * 2 * 2 * 0.55);
  }
  const kbps = Number(bitrateKbps) || format.defaultBitrate || 128;
  return Math.round((kbps * 1000 * durationSeconds) / 8);
}

/**
 * Traduce la coda del log FFmpeg in un messaggio comprensibile.
 * Ritorna '' se non riconosce la causa (resta il messaggio generico).
 */
export function describeFfmpegFailure(logText) {
  const text = String(logText ?? '');
  if (!text) {
    return '';
  }
  if (/matches no streams|does not contain any stream|Output file .* does not contain any stream/i.test(text)) {
    return 'Il file non contiene una traccia audio utilizzabile.';
  }
  if (/Cannot enlarge memory|out of memory|memory access out of bounds|Cannot allocate memory|OOM/i.test(text)) {
    return 'Memoria del browser esaurita: chiudi altre schede, riduci il numero di parti o usa un file più leggero.';
  }
  if (/Invalid data found when processing input|moov atom not found|could not find codec parameters/i.test(text)) {
    return 'Il file sembra danneggiato o in un formato non supportato.';
  }
  if (/Unknown encoder|Encoder not found/i.test(text)) {
    return 'Formato di uscita non supportato da questo motore: scegli M4A o MP3.';
  }
  if (/No space left|Quota|QuotaExceeded/i.test(text)) {
    return 'Spazio su disco esaurito durante la scrittura.';
  }
  return '';
}
