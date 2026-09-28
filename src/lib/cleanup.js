/**
 * Pulizia voce di livello professionale, tarata con misure oggettive
 * (loudness EBU R128, picco reale, rumore nelle pause, scarto voce
 * vicina/lontana) su registrazioni di lezione rumorose, basse e con clipping.
 *
 * Catena tipo (ordine voluto):
 *   mono → taglia rombo → livellatore LENTO (porta qualunque registrazione,
 *   anche bassissima, a un livello standard: da qui in poi tutte le soglie
 *   sono relative) → denoise spettrale adattivo → EQ anti-rimbombo +
 *   presenza → de-esser → livellatore VELOCE con soglia (voce vicina/lontana,
 *   ma non gonfia il rumore nelle pause lunghe) → expander sulle pause →
 *   compressore → limiter + guadagno calibrato.
 *
 * Senza la soglia del livellatore veloce una pausa di 10 s saliva da -54 a
 * -20 dB (rumore che "respira"); ora resta sotto -58 dB a qualunque volume
 * di registrazione (misurato a 0, -18 e -30 dB, rumore rosa e bianco).
 *
 * Lo stadio finale limiter+guadagno sostituisce loudnorm: stesso risultato
 * (-16 LUFS ±0,5 sulle prove) ma 5 volte più veloce, perché loudnorm
 * ricampiona internamente a 192 kHz.
 * Solo opzioni presenti in FFmpeg 5.1 (core ffmpeg.wasm 0.12).
 */

const MONO = 'aformat=channel_layouts=mono';
const RUMBLE = 'highpass=f=90:poles=2';
const VOICE_EQ = 'equalizer=f=250:t=q:w=1.2:g=-2,equalizer=f=3200:t=q:w=1:g=2.5';
// Finestra ~25 s: tarata nel core wasm (FFmpeg 5.1). Con 50 s i file più corti
// della finestra non venivano livellati; con 15 s le pause lunghe risalivano a -30 dB.
const SLOW_LEVELER = 'dynaudnorm=f=500:g=51:p=0.9:m=100:b=1';
// Soglia ~ -30 dBFS DOPO il livellatore lento (≈ 29 dB sotto la voce): con
// -40 dBFS il rumore di una pausa, già alzato dal livellatore lento, tornava a -20 dB.
const LEVELER = 'dynaudnorm=f=250:g=15:p=0.9:m=10:t=0.03';
const PAUSE_EXPANDER = 'agate=mode=downward:range=0.08:threshold=0.05:ratio=3:attack=10:release=400:knee=4';
const COMPRESSOR = 'acompressor=threshold=-20dB:ratio=2.5:attack=12:release=200:makeup=1.5:knee=4';
// Limiter a -8 dBFS + 3,8 dB: picchi a circa -4 dBFS e loudness ~ -16 LUFS
// (standard podcast/streaming) senza overs nemmeno dopo la codifica AAC.
const FINISH = 'alimiter=limit=0.4:attack=3:release=50:level=disabled,volume=3.8dB';
// In stereo la loudness somma i due canali (+~2,5 dB a parità di picco).
const FINISH_STEREO = 'alimiter=limit=0.4:attack=3:release=50:level=disabled,volume=1.3dB';
// Senza denoise/EQ il segnale resta più denso: 1 dB in meno per stare a -16 LUFS.
const FINISH_VOLUME_ONLY = 'alimiter=limit=0.4:attack=3:release=50:level=disabled,volume=0.3dB';

// Accorcia le pause oltre 1,2 s lasciandone 0,4 s: il ritmo resta naturale.
// A fine catena il rumore nelle pause è già sotto -55 dB: soglia affidabile.
export const SHORTEN_PAUSES_FILTER =
  'silenceremove=stop_periods=-1:stop_duration=1.2:stop_threshold=-45dB:stop_silence=0.4';

export const CLEANUP_PRESETS = {
  none: {
    id: 'none',
    label: 'Nessuna pulizia',
    description: 'Lascia il file com’è, nessun filtro applicato.',
    filters: [],
    mono: false,
    bitrateKbps: 0,
    speed: { desktop: 0, mobile: 0 },
    badges: [],
  },
  lecture: {
    id: 'lecture',
    label: 'Lezione in aula',
    description:
      'Toglie ronzio e rumore di fondo, rende chiara la voce e uniforma il volume anche quando il docente si allontana dal microfono.',
    filters: [MONO, RUMBLE, SLOW_LEVELER, 'afftdn=nr=14:nf=-40:tn=1', VOICE_EQ, 'deesser=i=0.3', LEVELER, PAUSE_EXPANDER, COMPRESSOR, FINISH],
    mono: true,
    bitrateKbps: 96,
    speed: { desktop: 100, mobile: 20 },
    badges: ['Consigliato', 'Mono voce', '−16 LUFS'],
  },
  podcast: {
    id: 'podcast',
    label: 'Podcast / intervista',
    description:
      'Pulizia morbida che conserva lo stereo e il timbro naturale: rumore attenuato, voci allo stesso livello, volume da piattaforma.',
    filters: [
      RUMBLE,
      SLOW_LEVELER,
      'afftdn=nr=10:nf=-42:tn=1',
      'equalizer=f=250:t=q:w=1.2:g=-1.5,equalizer=f=3200:t=q:w=1:g=2',
      'deesser=i=0.35',
      LEVELER,
      'agate=mode=downward:range=0.2:threshold=0.04:ratio=2:attack=10:release=400:knee=4',
      'acompressor=threshold=-20dB:ratio=3:attack=10:release=200:makeup=1.5:knee=4',
      FINISH_STEREO,
    ],
    mono: false,
    bitrateKbps: 160,
    speed: { desktop: 55, mobile: 11 },
    badges: ['Stereo', '−16 LUFS'],
  },
  memo: {
    id: 'memo',
    label: 'Memo vocale da telefono',
    description:
      'Per registrazioni fatte col cellulare: rumore ambientale più deciso, voce più presente e volume sempre alto.',
    filters: [
      MONO,
      'highpass=f=100:poles=2',
      SLOW_LEVELER,
      'afftdn=nr=18:nf=-38:tn=1',
      'equalizer=f=300:t=q:w=1.2:g=-3,equalizer=f=3200:t=q:w=1:g=3',
      'deesser=i=0.4',
      LEVELER,
      PAUSE_EXPANDER,
      COMPRESSOR,
      FINISH,
    ],
    mono: true,
    bitrateKbps: 96,
    speed: { desktop: 100, mobile: 20 },
    badges: ['Mono voce', '−16 LUFS'],
  },
  deep: {
    id: 'deep',
    label: 'Rumore forte',
    description:
      'Per aule rumorose, ventole o traffico: riduzione del rumore molto più aggressiva e banda vocale. Può rendere la voce leggermente metallica.',
    filters: [
      MONO,
      'highpass=f=110:poles=2,lowpass=f=9000',
      SLOW_LEVELER,
      'afftdn=nr=24:nf=-36:tn=1',
      VOICE_EQ,
      'deesser=i=0.35',
      LEVELER,
      'agate=mode=downward:range=0.05:threshold=0.06:ratio=4:attack=8:release=350:knee=4',
      COMPRESSOR,
      FINISH,
    ],
    mono: true,
    bitrateKbps: 96,
    speed: { desktop: 100, mobile: 20 },
    badges: ['Mono voce', 'Denoise forte'],
  },
  volume: {
    id: 'volume',
    label: 'Solo volume uniforme',
    description:
      'Non tocca il timbro: solo livello costante tra parti forti e deboli, pause silenziose e volume standard. La più veloce.',
    // L'expander leggero evita che il livellatore "gonfi" il rumore nelle pause.
    filters: [
      SLOW_LEVELER,
      LEVELER,
      'agate=mode=downward:range=0.3:threshold=0.04:ratio=2:attack=10:release=400:knee=4',
      COMPRESSOR,
      FINISH_VOLUME_ONLY,
    ],
    mono: false,
    bitrateKbps: 160,
    speed: { desktop: 110, mobile: 22 },
    badges: ['Velocissima', 'Stereo'],
  },
};

export const CLEANUP_ORDER = ['lecture', 'podcast', 'memo', 'deep', 'volume'];

export function getCleanupPreset(id) {
  return CLEANUP_PRESETS[id] ?? CLEANUP_PRESETS.none;
}

export function buildCleanupFilter(presetId, { shortenPauses = false } = {}) {
  const preset = getCleanupPreset(presetId);
  if (!preset || preset.filters.length === 0) {
    return '';
  }
  const filters = [...preset.filters];
  if (shortenPauses) {
    filters.push(SHORTEN_PAUSES_FILTER);
  }
  return filters.join(',');
}

/** Argomenti di codifica del risultato: AAC veloce, mono dove serve alla voce. */
export function buildCleanupOutputArgs(presetId) {
  const preset = getCleanupPreset(presetId);
  const args = [];
  if (preset.mono) {
    args.push('-ac', '1');
  }
  args.push(
    '-c:a', 'aac',
    '-aac_coder', 'fast',
    '-b:a', `${preset.bitrateKbps || 128}k`,
    '-movflags', '+faststart',
  );
  return args;
}

/** La pulizia cambia la durata (e quindi tagli e segnalibri) solo se accorcia le pause. */
export function cleanupChangesTimeline({ shortenPauses = false } = {}) {
  return Boolean(shortenPauses);
}

/**
 * Secondi stimati di elaborazione. `measuredSpeed` (× tempo reale misurato
 * su questo dispositivo) vince sui valori tipici del preset.
 */
export function estimateCleanupSeconds(presetId, audioDurationSeconds, { mobile = false, measuredSpeed = 0 } = {}) {
  const preset = getCleanupPreset(presetId);
  const duration = Number(audioDurationSeconds);
  if (!preset || preset.filters.length === 0 || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  const speed = Number(measuredSpeed) > 0
    ? Number(measuredSpeed)
    : (mobile ? preset.speed.mobile : preset.speed.desktop) || 20;
  return Math.max(2, Math.round(duration / speed));
}
