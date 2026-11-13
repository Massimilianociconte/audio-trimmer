# ADR 2026-11-13 — Android: ZIP su disco invece della cartella

## Contesto

Prove sul Galaxy Tab S8 vero (SM-X700, Android 16 / One UI 8, Chrome 157, collegato
in debug USB; dettagli in `PERFORMANCE-AUDIT.md`): Chrome Android espone sia
`showDirectoryPicker` sia `showSaveFilePicker` (selettori veri di Android,
DocumentsUI). Le prove precedenti emulavano un «Galaxy Tab» senza selettori e
quindi seguivano un altro percorso (file singoli / ZIP in memoria).

Sul tablet vero l'advisor sceglie:

- **ZIP su disco** (`zip-stream`) per progetti leggeri: si apre «Download» con il
  nome già scritto e un solo tasto «Salva».
- **Cartella** (`folder`) per progetti pesanti (input > 350 MB, uscita stimata
  > 250 MB) o con più di 8 parti: il selettore parte dalla radice con «Impossibile
  usare questa cartella»; bisogna entrare in una cartella, confermare e concedere
  l'accesso. In più la cartella esclude i due motori (`lib/parallelExport.js`).

Lezione 8 h → M4A in 2 parti, app nascosta: cartella, un motore, 9 min 6 s.

## Decisione

In `resolveExportModeForDevice` (`src/lib/device.js`): su Android, con
destinazione automatica e `showSaveFilePicker` disponibile, «cartella» diventa
«ZIP su disco». Nota nel pannello: «basta toccare «Salva», senza scegliere una
cartella». Quando la destinazione cambia per il dispositivo i motivi dell'advisor
(che descrivono l'altra) non vengono mostrati.

Invariati: scelta manuale della cartella, desktop, iPad/iPhone, Android senza
«Salva file», tutti gli altri casi dell'advisor.

## Alternative considerate

- **Due motori anche nella cartella**: richiede di controllare in anticipo le
  parti già presenti (ripresa `skipExisting`), oggi verificate una alla volta
  dentro il ciclo; resterebbe comunque il selettore cartella con più passaggi.
- **Lasciare tutto com'è**: un passaggio difficile per chi è poco pratico e metà
  della velocità proprio sui lavori più lunghi.

## Conseguenze

- Lavori pesanti su Android: un tocco su «Salva» invece di scegliere una cartella;
  due motori se due uscite stanno nel budget di una parte (512 MiB sul tablet).
  Misura sul tablet, 8 h → 2 parti, app nascosta: **5 min 55 s** (prima 9 min 6 s).
  ZIP identico byte per byte a quello creato con un motore.
- Il risultato è uno ZIP da estrarre invece di file separati nella cartella.
- Persa la ripresa della cartella (salto dei file già scritti dopo aver riscelto
  la stessa cartella): lo ZIP su disco non salva le parti per la ripresa, come già
  accadeva per i progetti leggeri. Con il lavoro in background le interruzioni
  sono più rare; la ripresa per lo ZIP su disco è un possibile passo successivo.
- Memoria della scheda con due motori su parti da 4 h: ~940 MB (un motore ~600 MB);
  nessuna chiusura forzata in 6 minuti in background.
- Non verificato: velocità di scrittura nel «Download» vero (le prove scrivono
  nello storage privato del sito per non creare file sul tablet).
- Prove: `src/lib/device.test.js` (Android con/senza «Salva file», scelta manuale,
  desktop, iPad).
