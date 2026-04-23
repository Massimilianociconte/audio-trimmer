export const CLEANUP_PRESETS = {
  none: {
    id: 'none',
    label: 'Nessuna pulizia',
    description: 'Lascia il file com’è, nessun filtro applicato.',
    filters: [],
    speed: 0,
  },
  lecture: {
    id: 'lecture',
    label: 'Voce in aula',
    description:
      'Filtra rumori bassi, uniforma il volume con un normalizzatore dinamico veloce e taglia le pause oltre 2 secondi. Consigliato per ogni lezione.',
    filters: [
      'highpass=f=100',
      'lowpass=f=8000',
      'dynaudnorm=f=400:g=15:p=0.95',
      'silenceremove=start_periods=1:start_duration=0.3:start_threshold=-40dB:stop_periods=-1:stop_duration=2:stop_threshold=-38dB',
    ],
    speed: 0.3,
  },
  podcast: {
    id: 'podcast',
    label: 'Podcast / intervista',
    description:
      'Pulizia morbida: normalizza il volume dinamicamente e uniforma le voci, mantenendo il ritmo naturale. Veloce.',
    filters: [
      'highpass=f=60',
      'dynaudnorm=f=300:g=20:p=0.9',
      'acompressor=threshold=-20dB:ratio=3:attack=10:release=200',
    ],
    speed: 0.25,
  },
  memo: {
    id: 'memo',
    label: 'Memo vocale',
    description:
      'Pulizia minima ma rapida: volume livellato e rumori bassi tagliati, pause preservate.',
    filters: ['highpass=f=80', 'dynaudnorm=f=300:g=15'],
    speed: 0.15,
  },
  deep: {
    id: 'deep',
    label: 'Pulizia profonda (lenta)',
    description:
      'Aggiunge un denoiser spettrale e la normalizzazione EBU R128. La resa è migliore ma l’elaborazione può richiedere più tempo della durata stessa del file: usa solo per registrazioni molto rumorose.',
    filters: [
      'highpass=f=100',
      'lowpass=f=8000',
      'afftdn=nf=-25',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      'silenceremove=start_periods=1:start_duration=0.3:start_threshold=-40dB:stop_periods=-1:stop_duration=2:stop_threshold=-38dB',
    ],
    speed: 1.6,
  },
};

export const CLEANUP_ORDER = ['lecture', 'podcast', 'memo', 'deep', 'none'];

export function getCleanupPreset(id) {
  return CLEANUP_PRESETS[id] ?? CLEANUP_PRESETS.none;
}

export function buildCleanupFilter(presetId) {
  const preset = getCleanupPreset(presetId);
  if (!preset || preset.filters.length === 0) {
    return '';
  }
  return preset.filters.join(',');
}

export function estimateCleanupSeconds(presetId, audioDurationSeconds) {
  const preset = getCleanupPreset(presetId);
  if (!preset || !preset.speed || !audioDurationSeconds) {
    return 0;
  }
  return Math.max(3, Math.round(preset.speed * audioDurationSeconds));
}
