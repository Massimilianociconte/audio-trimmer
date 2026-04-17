import { clamp, formatClock, parseTimeInput } from './time.js';

const MIN_SLICE_DURATION = 0.25;

function createSegments(boundaries) {
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return {
      index: index + 1,
      start,
      end,
      duration: end - start,
      label: `Parte ${index + 1}`,
      rangeLabel: `${formatClock(start)} - ${formatClock(end)}`,
    };
  });
}

function sanitizeCutPoints(duration, rawCuts) {
  const parsedCuts = rawCuts
    .map((item) => {
      const numericPosition =
        typeof item.position === 'number' && Number.isFinite(item.position)
          ? item.position
          : null;
      return {
        ...item,
        parsed: numericPosition !== null ? numericPosition : parseTimeInput(item.value),
      };
    })
    .filter((item) => {
      if (typeof item.position === 'number' && Number.isFinite(item.position)) {
        return true;
      }
      return typeof item.value === 'string' && item.value.trim().length > 0;
    });

  const invalid = parsedCuts.find((item) => item.parsed === null);
  if (invalid) {
    return { error: `Il punto "${invalid.value}" non ha un formato valido.` };
  }

  const normalized = parsedCuts
    .map((item) => clamp(item.parsed, 0, duration))
    .filter((value) => value > 0 && value < duration)
    .sort((left, right) => left - right);

  const deduped = normalized.filter((value, index) => {
    if (index === 0) {
      return true;
    }

    return value - normalized[index - 1] >= MIN_SLICE_DURATION;
  });

  if (deduped.length === 0) {
    return { error: 'Aggiungi almeno un punto di taglio valido.' };
  }

  const boundaries = [0, ...deduped, duration];
  const tooSmall = boundaries.some((value, index) => {
    if (index === 0) {
      return false;
    }

    return value - boundaries[index - 1] < MIN_SLICE_DURATION;
  });

  if (tooSmall) {
    return { error: 'Ogni parte deve durare almeno 0,25 secondi.' };
  }

  return { cutPoints: deduped, segments: createSegments(boundaries) };
}

function buildEqualSegments(duration, parts) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { error: 'Durata non disponibile.' };
  }

  if (!Number.isInteger(parts) || parts < 2) {
    return { error: 'Servono almeno 2 parti.' };
  }

  const step = duration / parts;
  const boundaries = Array.from({ length: parts + 1 }, (_, index) =>
    index === parts ? duration : Number((step * index).toFixed(6)),
  );

  return { cutPoints: boundaries.slice(1, -1), segments: createSegments(boundaries) };
}

export function buildPlan({ duration, mode, equalParts, customCuts }) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { error: 'Carica un file audio per vedere il piano di taglio.', segments: [], cutPoints: [] };
  }

  if (mode === 'custom') {
    const customPlan = sanitizeCutPoints(duration, customCuts);
    return {
      error: customPlan.error ?? '',
      segments: customPlan.segments ?? [],
      cutPoints: customPlan.cutPoints ?? [],
    };
  }

  const equalPlan = buildEqualSegments(duration, equalParts);
  return {
    error: equalPlan.error ?? '',
    segments: equalPlan.segments ?? [],
    cutPoints: equalPlan.cutPoints ?? [],
  };
}

export function buildDownloadName(baseName, index, extension) {
  return `${baseName} - parte ${index}${extension}`;
}

export function buildVirtualSegmentName(prefix, index, extension) {
  return `${prefix}-${String(index).padStart(3, '0')}${extension}`;
}
