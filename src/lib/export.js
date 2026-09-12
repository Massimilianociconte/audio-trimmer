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
};

export const EXPORT_FORMAT_ORDER = ['m4a', 'mp3', 'ogg', 'wav'];

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
    return [
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
      outputName,
    ];
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
  if (fadeFilter) {
    args.push('-af', fadeFilter);
  }

  if (format.id === 'wav') {
    args.push('-c:a', format.codec);
  } else {
    const available = format.bitrates.length > 0 ? format.bitrates : [bitrateKbps];
    const nearest = available.reduce((best, candidate) =>
      Math.abs(candidate - bitrateKbps) < Math.abs(best - bitrateKbps) ? candidate : best,
    );
    args.push('-c:a', format.codec, '-b:a', `${nearest}k`);
  }

  if (format.needsMovflags) {
    args.push('-movflags', '+faststart');
  }

  args.push(outputName);
  return args;
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
  const kbps = Number(bitrateKbps) || format.defaultBitrate || 128;
  return Math.round((kbps * 1000 * durationSeconds) / 8);
}
