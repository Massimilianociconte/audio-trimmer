# ADR 2026-11-12 — Export riprendibili e motore mobile su tablet

## Contesto

Su iPad e tablet Samsung l'elaborazione si ferma quando l'utente cambia app
o il browser va in secondo piano. Cause verificate (documentazione delle
piattaforme, novembre 2026):

- **iPadOS/iOS Safari**: l'app in secondo piano viene sospesa in pochi
  secondi; pagina, worker e wasm si fermano. Nessuna API web lo impedisce.
- **Chrome Android**: le pagine in secondo piano vengono congelate dopo
  1 minuto (Chrome 139+, prima 5 minuti), worker dedicati compresi; Android
  14+ congela anche i processi in cache dopo ~10 s e, con poca memoria, il
  sistema chiude per primi i renderer in secondo piano.
- I Web Worker **non** garantiscono esecuzione in background: seguono la
  pagina. I Service Worker hanno vita limitata, non hanno `FileReaderSync`
  (WORKERFS) e non sono pensati per ore di calcolo.
- Wake Lock vale solo con pagina visibile.

Prima della modifica: tutte le parti di uno ZIP in memoria vivevano nella
scheda; se il sistema la chiudeva, il lavoro era perso. Al ritorno il
lavoro riprendeva (le scadenze contano già solo il tempo attivo), ma il
testo diceva «il lavoro continua» anche su tablet.

## Decisione

Solo telefoni/tablet (`isMobileDevice()`); desktop invariato.

1. **Export riprendibili** (`src/lib/exportJobs.js`, database IndexedDB
   separato `audio-cutter-export-jobs`):
   - ZIP in memoria con lavoro stimato ≥ 15 s: ogni parte pronta salvata come
     Blob; file singoli: si annota solo quali parti sono già scaricate.
   - Un nuovo «Taglia e scarica» con stessa sorgente, tagli e impostazioni
     audio (impronta) riusa le parti salvate e riparte dalla prima mancante.
   - Dopo una chiusura della scheda, all'avvio un avviso propone la ripresa;
     riaprendo lo stesso file (nome, dimensione, data, durata) tagli e
     impostazioni si ripristinano.
   - Ogni operazione ha scadenza in tempo attivo e non lancia: senza
     IndexedDB o quota l'export procede come prima.
   - Job scaduti dopo 3 giorni; uno solo alla volta; eliminato a export
     completato o annullato.
2. **Meno memoria in secondo piano**: a riposo, quando la pagina va nascosta,
   il motore FFmpeg viene terminato (si ricompila dalla cache al prossimo
   uso): il sistema chiude la scheda più di rado.
3. **Worker mobile** (`src/workers/ffmpegMobileWorker.js` +
   `src/lib/outputTransfer.js`): preassegnazione dell'uscita MEMFS e
   consegna per trasferimento (zero copie). Attivato solo dopo una prova
   (ping) del worker; ogni passo ha un ripiego sul comportamento originale.
4. **Testi onesti**: su tablet l'avanzamento dice di tenere l'app in primo
   piano e che le parti pronte restano salvate; al ritorno «Elaborazione
   ripresa».
5. **Nessuna attesa infinita** (bug preesistente, trovato nei test): un worker
   che muore tra due comandi non avvisa e le promesse di `@ffmpeg/ffmpeg`
   restano appese. Nell'export, suggerimento dimensione, lettura e
   cancellazione dell'uscita hanno una scadenza di 90 s in tempo attivo;
   scaduta, il motore viene terminato e ricreato. Vale anche su desktop (solo
   nel caso di blocco).

## Alternative scartate

- **Elaborazione su server**: rompe la promessa «nessun upload», upload di
  centinaia di MB da rete mobile più lenti del taglio locale, hosting statico.
- **Service Worker / Background Fetch / Background Sync**: non eseguono ore
  di calcolo wasm, niente `FileReaderSync`, limiti di vita.
- **Audio silenzioso per restare attivi**: fragile, viola le linee guida
  delle piattaforme, consuma batteria; iPadOS lo interrompe comunque.
- **ffmpeg core multi-thread**: richiede COOP/COEP (su GitHub Pages solo via
  hack del Service Worker), più RAM per thread; instabile su iPad.
- **Più worker in parallelo**: moltiplica i picchi di memoria (crash già
  visti su tablet).
- **Read-ahead WORKERFS**: nessun beneficio misurato (l'input non è il collo
  di bottiglia).
- **WebCodecs**: supporto codec/contenitori incompleto su Safari; riscrittura
  dell'intera pipeline.

## Conseguenze

- Il lavoro in secondo piano resta sospeso dal sistema: la modifica rende
  l'interruzione **recuperabile**, non impossibile.
- Lo ZIP in memoria su tablet scrive anche su IndexedDB (stesso ordine di
  memoria: i byte diventano il Blob salvato e lo ZIP lo legge da lì).
- Safari in navigazione privata rifiuta i Blob in IndexedDB («Error preparing
  Blob/File data to be stored in object store», verificato in WebKit
  effimero): niente ripresa, export invariato. Nessun ripiego su ArrayBuffer:
  in privata IndexedDB vive in RAM e aumenterebbe il rischio di crash.
- Su WebKit un ricaricamento ferma il worker prima di `pagehide`: l'export
  «fallisce» e il checkpoint classico viene cancellato (comportamento
  preesistente). Con parti salvate la ripresa funziona comunque.
- Test riproducibili: `scripts/tablet-interruption-audit.mjs` (kill, reload,
  crash del worker, sospensione SIGSTOP, rilascio a riposo, file singoli).
- Da verificare su dispositivi reali: quota IndexedDB e Blob grandi su iPad
  Safari, comportamento di Samsung Internet, chiusura della scheda per
  memoria su tablet da 3–4 GB.
