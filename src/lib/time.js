export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function formatClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) {
    return '--:--';
  }

  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.round((safeSeconds - Math.floor(safeSeconds)) * 10);

  const hourPrefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : '';
  const clock = `${hourPrefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return milliseconds > 0 ? `${clock}.${milliseconds}` : clock;
}

export function parseTimeInput(rawValue) {
  if (!rawValue) {
    return null;
  }

  const normalized = rawValue.trim().replace(',', '.');
  if (!normalized) {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(normalized)) {
    return Number(normalized);
  }

  const chunks = normalized.split(':');
  if (chunks.length > 3) {
    return null;
  }

  const numbers = chunks.map((chunk) => Number(chunk));
  if (numbers.some((value) => Number.isNaN(value))) {
    return null;
  }

  if (chunks.length === 2) {
    return numbers[0] * 60 + numbers[1];
  }

  if (chunks.length === 3) {
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  }

  return null;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function getExtension(filename) {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(lastDot) : '';
}

export function stripExtension(filename) {
  const extension = getExtension(filename);
  return extension ? filename.slice(0, -extension.length) : filename;
}
