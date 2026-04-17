const SILENCE_START_REGEX = /silence_start:\s*(-?[\d.]+)/g;
const SILENCE_END_REGEX = /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;

export function parseSilenceLog(logText) {
  if (!logText) {
    return [];
  }

  const starts = [];
  const ends = [];

  let match;
  SILENCE_START_REGEX.lastIndex = 0;
  while ((match = SILENCE_START_REGEX.exec(logText)) !== null) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) {
      starts.push(value);
    }
  }

  SILENCE_END_REGEX.lastIndex = 0;
  while ((match = SILENCE_END_REGEX.exec(logText)) !== null) {
    const end = Number.parseFloat(match[1]);
    const duration = Number.parseFloat(match[2]);
    if (Number.isFinite(end) && Number.isFinite(duration)) {
      ends.push({ end, duration });
    }
  }

  const silences = [];
  const total = Math.min(starts.length, ends.length);
  for (let index = 0; index < total; index += 1) {
    const start = starts[index];
    const { end, duration } = ends[index];
    if (end > start) {
      silences.push({ start, end, duration });
    }
  }

  return silences;
}

export function silencesToCutPoints({
  silences,
  duration,
  minSegmentLength = 5,
  edgeMargin = 0.25,
}) {
  if (!Array.isArray(silences) || silences.length === 0 || !(duration > 0)) {
    return [];
  }

  const candidates = silences
    .map((gap) => {
      const mid = (gap.start + gap.end) / 2;
      return Math.max(edgeMargin, Math.min(duration - edgeMargin, mid));
    })
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((left, right) => left - right);

  if (minSegmentLength <= 0) {
    return candidates;
  }

  const filtered = [];
  let lastBoundary = 0;
  for (const cut of candidates) {
    if (cut - lastBoundary < minSegmentLength) {
      continue;
    }
    if (duration - cut < minSegmentLength) {
      break;
    }
    filtered.push(cut);
    lastBoundary = cut;
  }

  return filtered;
}

export function buildSilenceDetectFilter({ thresholdDb = -30, minSilenceSeconds = 2 }) {
  const safeThreshold = Number.isFinite(thresholdDb) ? thresholdDb : -30;
  const safeDuration = Number.isFinite(minSilenceSeconds) && minSilenceSeconds > 0 ? minSilenceSeconds : 2;
  return `silencedetect=noise=${safeThreshold}dB:d=${safeDuration}`;
}
