# ADR 2026-11-12 — Conversioni su due motori (Android 8 GB / 8 core)

## Contesto

Su un Galaxy Tab S8 (Snapdragon 8 Gen 1, 8 GB, Chrome) le fasi lente sono quelle
limitate dalla CPU: conversione (mp3 → m4a di 2 h ≈ 80 s stimati sul tablet) e
pulizia. Il taglio senza ricodifica, la forma d'onda e il file pronto sono già
veloci. Gli encoder audio di FFmpeg (aac, libmp3lame, libvorbis, flac) sono
single-thread anche nel core multi-thread: un export usa un solo core su otto.

Misure in emulazione (Chromium, profilo Android, M5 Pro ≈ 2,5× un core del
tablet), 2 h mp3 → m4a in 6 parti, motori ffmpeg.wasm indipendenti:
1 motore 34,5 s, 2 motori 17,4 s, 3 motori 12,6 s, 4 motori 12,5 s;
picco 381 / 600 / 753 / 735 MiB. Uscite identiche byte per byte.

## Decisione

`src/lib/parallelExport.js`, usato dal ciclo di export in `App.jsx`.

1. **Quando**: solo Android, `deviceMemory` ≥ 8 (massimo esposto da Chrome
   Android) e `hardwareConcurrency` ≥ 8, niente risparmio dati, conversione (non
   taglio senza ricodifica) in M4A/MP3/OGG, almeno 2 parti da creare, destinazione
   diversa da cartella, e due uscite stimate entro il budget di memoria di UNA
   parte. Altrove (desktop, iPad, Android più piccoli, WAV/FLAC, taglio veloce):
   flusso sequenziale invariato.
2. **Come**: due motori (2, non 3: margine per calore e memoria su tablet). Una
   coda prepara la parte successiva sul motore libero; il consumo (ZIP, salvataggi
   per la ripresa, download, checkpoint) resta sequenziale e nell'ordine delle
   parti. Al massimo 2 uscite vive. Stessi comandi ⇒ stesse uscite.
3. **Secondo motore**: creato dopo l'avvio dell'export (il principale lavora già),
   solo con il wasm già servito dalla cache del service worker (mai un secondo
   download da 32 MB), input montato via WORKERFS (mai una copia integrale).
   Chiuso a fine export, su errore e su annullo.
4. **Ripieghi**: se il secondo motore non arriva, si prosegue con uno. Se fallisce
   o si ferma (30 s attivi senza avanzamento o risposta), viene chiuso e la parte
   rifatta sul principale. Un errore del principale segue il percorso di sempre
   (motore ricreato, parti salvate tenute). Se l'export si interrompe mentre il
   principale sta ancora preparando una parte, il principale viene ricreato.
5. La velocità imparata per le stime (ETA, soglia di persistenza) resta quella di
   un motore: le stime non diventano ottimiste quando il parallelo non c'è.

## Alternative scartate

- **3 o più motori**: +27% di velocità su 2 in emulazione, ma il tablet ha 4 core
  grandi (1 X2 + 3 A710), calore non misurato e +150 MiB per motore.
- **Core multi-thread**: nessun beneficio per gli encoder audio, COOP/COEP via hack
  del service worker, ~1 GB di memoria iniziale.
- **Dividere una singola parte e ricucirla**: giunzioni AAC (sovrapposizione MDCT)
  e riserva di bit MP3 da gestire; sperimentale.
- **Pulizia a blocchi in parallelo**: nessun click alla giunzione, ma uscita non
  identica (livellatore: differenze di livello mediana 0,02 dB, max 1,1 dB) e
  ricomposizione AAC complessa.
- **MP3 a qualità più bassa** (−9%/−26% di tempo con q5/q7): peggiora la qualità.
- **WebCodecs AAC (MediaCodec)**: possibile guadagno maggiore per M4A, ma da misurare
  sul tablet (qualità/velocità dell'encoder Samsung) e riscrittura del percorso.

## Conseguenze

- Conversioni con ≥ 2 parti ≈ 2× più veloci sui dispositivi ammessi; nessun
  guadagno con una sola parte, sul taglio senza ricodifica e sulla pulizia.
- +30–230 MiB durante l'export (secondo motore e una parte in anticipo).
- Da verificare sul tablet: tempi reali, calo per calore su conversioni lunghe,
  memoria con due motori, valore effettivo di `hardwareConcurrency`.
- Prove: `src/lib/parallelExport.test.js`; scenari di interruzione in
  `scripts/tablet-interruption-audit.mjs` (sul profilo Galaxy il parallelo è attivo).

## Verifica sul tablet (2026-11-13)

Galaxy Tab S8 vero, Chrome 157: `deviceMemory` 8 e `hardwareConcurrency` 8, due
motori attivi. 2 h → 4 parti M4A in 1 min 9 s; 8 h → 2 parti da nascosta in 5 min
55 s (un motore: 9 min 17 s), scheda fino a ~940 MB, nessun calo per calore. Il
secondo motore parte solo con la pagina controllata dal service worker (prima visita
esclusa, come previsto). Su Android la destinazione «cartella» non viene più scelta
in automatico: vedi `2026-11-13-android-zip-su-disco.md`.
