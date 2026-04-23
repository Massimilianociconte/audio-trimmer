export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function formatClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) {
    return '--:--';
  }

  const totalTenths = Math.round(Math.max(0, totalSeconds) * 10);
  const totalWholeSeconds = Math.floor(totalTenths / 10);
  const hours = Math.floor(totalWholeSeconds / 3600);
  const minutes = Math.floor((totalWholeSeconds % 3600) / 60);
  const seconds = totalWholeSeconds % 60;
  const tenths = totalTenths % 10;

  const hourPrefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : '';
  const clock = `${hourPrefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return tenths > 0 ? `${clock}.${tenths}` : clock;
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

  const chunks = normalized.split(':').map((chunk) => chunk.trim());
  if (chunks.length > 3) {
    return null;
  }
  if (chunks.length < 2 || chunks.some((chunk) => chunk.length === 0)) {
    return null;
  }
  if (!chunks.every((chunk) => /^\d+(\.\d+)?$/.test(chunk))) {
    return null;
  }
  if (chunks.slice(0, -1).some((chunk) => chunk.includes('.'))) {
    return null;
  }

  const numbers = chunks.map((chunk) => Number(chunk));
  if (numbers.some((value) => !Number.isFinite(value))) {
    return null;
  }

  if (chunks.length === 2) {
    if (numbers[1] >= 60) {
      return null;
    }
    return numbers[0] * 60 + numbers[1];
  }

  if (chunks.length === 3) {
    if (numbers[1] >= 60 || numbers[2] >= 60) {
      return null;
    }
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
  return lastDot > 0 ? filename.slice(lastDot).toLowerCase() : '';
}

export function stripExtension(filename) {
  const extension = getExtension(filename);
  return extension ? filename.slice(0, -extension.length) : filename;
}
