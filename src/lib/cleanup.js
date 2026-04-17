export const CLEANUP_PRESETS = {
  none: {
    id: 'none',
    label: 'Nessuna pulizia',
    description: 'Lascia il file com’è, nessun filtro applicato.',
    filters: [],
  },
  lecture: {
    id: 'lecture',
    label: 'Voce in aula',
    description:
      'Normalizza il volume, toglie rumori bassi e taglia le pause oltre 2 secondi. Ideale per lezioni registrate.',
    filters: [
      'highpass=f=100',
      'lowpass=f=8000',
      'afftdn=nf=-25',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      'silenceremove=start_periods=1:start_duration=0.3:start_threshold=-40dB:stop_periods=-1:stop_duration=2:stop_threshold=-38dB',
    ],
  },
  podcast: {
    id: 'podcast',
    label: 'Podcast / intervista',
    description:
      'Pulizia morbida: normalizza il volume e uniforma le voci, mantiene il ritmo naturale.',
    filters: [
      'highpass=f=60',
      'loudnorm=I=-18:TP=-1.5:LRA=11',
      'acompressor=threshold=-20dB:ratio=3:attack=10:release=200',
    ],
  },
  memo: {
    id: 'memo',
    label: 'Memo vocale',
    description:
      'Pulizia leggera: volume livellato e taglio del rumore costante di fondo, pause preservate.',
    filters: [
      'highpass=f=80',
      'afftdn=nf=-20',
      'loudnorm=I=-17:TP=-1.5:LRA=11',
    ],
  },
};

export const CLEANUP_ORDER = ['lecture', 'podcast', 'memo', 'none'];

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
