# ADR 2026-11-12 — Lavoro in background su Chrome Android

Aggiorna `2026-11-12-export-riprendibili-mobile.md`, che aveva scartato l'audio
per restare attivi: su richiesta esplicita (tablet Samsung, export di decine di
minuti mentre si usano altre app) la scelta è stata rivista con prove sul motore
reale di Chrome.

## Contesto

Su Galaxy Tab S8 (Chrome) uscire dall'app fermava l'export: al ritorno «Elaborazione
ripresa», ma i minuti passati fuori erano persi. Cause, verificate nel sorgente
Chromium (novembre 2026):

- Blink congela pagina e worker dedicati 1 minuto dopo che la pagina è nascosta
  (`kStopInBackground`, `kDefaultDelayForBackgroundTabFreezing = 1 min`, Chrome 139+).
  Il congelamento **non** si applica se la pagina riproduce audio:
  `PageSchedulerImpl::IsBackgrounded()` = `!IsPageVisible() && !IsAudioPlaying() && …`.
- «Udibile» per Chrome = potenza d'uscita sopra **−72,25 dBFS**
  (`kSilenceThresholdDBFS`, `services/audio/output_stream.cc`, misura 15 volte al
  secondo). Il silenzio digitale non conta.
- Android congela i processi in cache: Chrome resta attivo in secondo piano solo con
  un servizio in primo piano. Per una pagina web l'unico disponibile è quello della
  **notifica multimediale**, che Chrome avvia per un elemento audio di almeno 5 s.

## Decisione

`src/lib/backgroundWork.js` + `src/hooks/useBackgroundWork.js`; solo Chrome Android
(`isAndroid`, non iOS). iPad/iPhone e desktop invariati.

1. Durante export e operazioni del motore (pulizia, silenzi, export per AI) un
   elemento `Audio` suona in loop un WAV generato in pagina: 10 s, 8 kHz, **30 Hz a
   −50 dBFS di picco** (potenza ≈ −53 dBFS, ~19 dB sopra la soglia di Chrome).
   A 30 Hz quel livello è sotto la soglia dell'udito anche in cuffia al massimo, e gli
   altoparlanti di telefoni e tablet non lo riproducono. Loop senza scatti (periodi
   interi).
2. La Media Session mostra l'avanzamento nella notifica («Taglio in corso · 42%»,
   «Parte 3 di 8 · restano ~6 min»), aggiornata al massimo ogni 4 s. Niente gira di
   nascosto: la notifica è visibile e dalla notifica si mette in pausa.
3. Avvio con il tocco su «Taglia e scarica» (attivazione utente), arresto a fine
   lavoro. Se l'app è nascosta a fine lavoro il tono resta 5 s (download finali), poi
   la notifica mostra l'esito («Taglio completato in 4 min · 8 parti pronte») finché
   non si torna nell'app.
4. Interruttore nel pannello di avanzamento, acceso di default e ricordato
   (`localStorage` `audio-cutter-background-work`). Se un'altra app prende l'audio
   (musica, video, cuffie scollegate) o si preme pausa nella notifica, il tono si
   ferma: il pannello lo dice e offre «Riattiva». Nessuna ripresa automatica, per non
   rubare l'audio all'altra app.
5. Al ritorno nell'app: «Il lavoro è continuato in background — da 12% a 47%» se
   l'avanzamento è cresciuto, altrimenti il messaggio di pausa. Le parti salvate per
   la ripresa restano come rete di sicurezza.

## Alternative scartate

- **Silenzio digitale / volume 0 / elemento muto**: per Chrome non è udibile, la
  pagina viene congelata (provato).
- **Web Audio (`AudioContext`)**: tiene la pagina udibile ma non crea la notifica né
  il servizio in primo piano: Android può congelare Chrome.
- **Suono udibile ma basso**: disturba e si sente in cuffia.
- **App Android nativa (WebView + servizio in primo piano `mediaProcessing`)**:
  soluzione più robusta, ma richiede un'app da installare fuori dal Play Store e un
  secondo progetto da mantenere. Da riconsiderare se la prova sul tablet fallisce.
- **Service Worker, Background Fetch, Wake Lock, Web Locks**: non eseguono il wasm o
  non impediscono il congelamento su Android.

## Conseguenze

- Su Chrome Android export e pulizia proseguono con l'app in secondo piano o lo
  schermo spento, più lentamente (priorità bassa, CPU a frequenza ridotta).
- Durante il lavoro la musica di altre app viene messa in pausa (focus audio); se poi
  si avvia musica o video altrove, il lavoro in background si ferma fino al ritorno.
- Dipende da euristiche di Chrome che Google può cambiare; se cambiano si torna al
  comportamento precedente (pausa e ripresa), senza errori.
- Le scadenze del motore contano solo il tempo con la pagina visibile: se un worker
  muore mentre l'app è nascosta, il ripiego scatta al ritorno.
- Batteria: lavoro di CPU in secondo piano; il tono costa poco.
- Prove (Chrome 156, congelamento di Android attivato, scheda nascosta; dettagli in
  `PERFORMANCE-AUDIT.md`): senza audio o con silenzio digitale pagina e worker fermi a
  ~60 s; con il tono attivi per 6,5 min. App vera, export 8 h → M4A in 4 parti da
  nascosta: 0 parti in 7 min con l'interruttore spento, 4 su 4 con quello acceso.
  Da verificare sul tablet: servizio in primo piano e congelamento dei processi di
  Android/One UI, focus audio Samsung, velocità reale in background.

## Verifica sul tablet (2026-11-13)

Galaxy Tab S8 vero, Chrome 157, app nascosta con il tasto Home (dettagli in
`PERFORMANCE-AUDIT.md`, «Prove sul Galaxy Tab S8 reale»): con il tono Chrome è un
servizio in primo piano, nessun processo congelato fino a 9 minuti, ~85–90% della
velocità visibile; notifica finale con l'esito, tolta al ritorno. Con l'interruttore
spento: 4 volte più lento appena nascosto, pagina congelata dopo ~1 minuto. Restano
da provare schermo spento/bloccato, musica di altre app, risparmio energetico.
