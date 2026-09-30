# Audit performance e memoria — 30 settembre 2026

L’architettura esistente è stata mantenuta. Il maggiore collo di bottiglia confermato era la
decodifica integrale della waveform, soprattutto lo staging del decoder nativo: abbassare
la frequenza del PCM finale non bastava a controllarne il picco. Sono state applicate
guardie più realistiche, ridotti i riferimenti residenti e corretti i percorsi di errore e annullamento.

La piattaforma è **interamente locale**: selezionare un audio non avvia un upload a un server.
Non esistono quindi API audio multipart, chunk da ritrasmettere o ricezione del risultato remoto.
La rete serve principalmente a scaricare la PWA e il motore FFmpeg. Aggiungere un backend
o un protocollo di upload avrebbe cambiato il prodotto senza risolvere il problema osservato.

## Cosa funzionava già e rimane

- Input `File`/`Blob` montato tramite WORKERFS nel worker FFmpeg: letture del filesystem
  senza un `ArrayBuffer` dell’intero input nel main thread.
- FFmpeg single-thread in worker, taglio senza ricodifica quando compatibile, elaborazione
  sequenziale dei segmenti e cancellazione tramite terminazione del worker.
- Cartella e ZIP su disco come destinazioni progressive; scrittura dei byte senza Blob
  intermedio nel percorso cartella. Nessuna concatenazione dell’intero audio sul main thread.
- Anteprima HTMLAudio nativa già disponibile, waveform a frequenza ridotta per file piccoli,
  timeline adattiva, aggiornamenti del playback limitati e yielding tra segmenti.
- Libreria v2 con metadati separati dall’audio, controllo quota, cache WASM limitata,
  caricamento del motore condiviso e aggiornamenti PWA su richiesta dell’utente.
- Nessuna conversione audio in Base64/Data URL e nessun upload implicito dei contenuti.

## Problemi, cause, interventi e beneficio

| Problema e causa | Impatto | Soluzione applicata | Beneficio/evidenza |
|---|---|---|---|
| Guardia waveform basata soprattutto sul PCM finale a 3/8 kHz | Il decoder può usare molto più RAM prima del ricampionamento | Budget con due copie dell’input, PCM finale e due workspace stereo stimati a 48 kHz; anteprima nativa sopra soglia | Su WAV 250 MiB: picco RSS di produzione −77,5%; nessuna lettura integrale via `Blob.arrayBuffer()` |
| WaveSurfer caricava l’object URL tramite fetch; in StrictMode potevano partire due decode | Blob aggiuntivo e lavoro duplicato in sviluppo | `loadBlob` sul File originale, durata già nota, avvio in microtask con guardia di dismount | Un solo decode per file piccolo anche in StrictMode; nessun fetch della sorgente audio |
| `destroy()` non interrompe necessariamente `decodeAudioData()` | Decode precedenti e rendering di canvas staccati potevano sovrapporsi ad altri lavori | Contatore dei decode realmente pendenti, blocco delle operazioni pesanti fino alla conclusione, soppressione del rendering tardivo | Test di decode dopo dismount e fallback; nessun avvio concorrente di FFmpeg mentre il decode è pendente |
| Fallback WORKERFS→MEMFS senza limite | Copia integrale di input da centinaia di MB, oltre al filesystem WASM | Fallback limitato a 8 MiB su mobile/PC deboli e 32 MiB sugli altri desktop; nessun fallback su worker terminato | Test con input 500 MiB: zero chiamate `arrayBuffer()` nel fallback rifiutato |
| Output MEMFS grande anche quando la destinazione finale è streaming | Crescita del filesystem, copia `readFile`, eventuale Blob contemporanei | Preflight per segmento, margine 15%, limite FFmpeg `-fs`, verifica del risultato e cancellazione immediata del file virtuale | Le due parti WAV da ~250 MiB vengono rifiutate prima della codifica; output troppo grandi richiedono più parti o bitrate minore |
| ZIP compatibile e re-download trattenevano risultati troppo grandi | Accumulo dell’intero archivio e riferimenti persistenti | Limite totale ZIP e limite separato di conservazione, anche sulle dimensioni effettive; ZIP STORE senza retry di add fallite | Picco e durata dei riferimenti limitati; la seconda compressione di audio già compresso viene evitata |
| Abort di ZIP durante la directory finale o scrittura disco pendente | UI bloccata o commit parziale presentato come riuscito | Writer del sink posseduto esplicitamente, relay con backpressure, race con abort anche per write/close; abort invece di finalizzare su errore | Test di scritture bloccate e directory ZIP bloccata: annullamento tempestivo, nessun successo falso |
| Download WASM interrotto durante il body non sempre riprendibile; timeout incompleti | Attese indefinite, trasferimenti ripetuti, cache incompleta | Abort per tentativo, deadline su header/body, massimo tre tentativi, Range validato, restart se Content-Encoding rende inaffidabili gli offset | Test di body interrotto, rete bloccata, Range errato, risposta corta/eccessiva e risposta compressa |
| Log e progress molto frequenti; worker silenzioso dopo OOM | Rerender e accumulo log, job senza conclusione | Progress FFmpeg a ~5/s, log UI a ~2/s, cattura silenzi filtrata con limite 1 MiB, watchdog di inattività 120 s | Test dei burst e della terminazione del worker silenzioso; listener/timer rimossi in finally |
| FFprobe metadata senza deadline | Un worker morto poteva lasciare l’analisi pendente | Scadenza assoluta 120 s, terminazione e invalidazione del mount; preservato il codice -1 del core | Test di timeout e cancellazione del timer dopo probe riuscito |
| Warm-up dopo selezione anche su mobile e PC deboli | Compilazione e worker residenti prima che servano | Warm-up solo su desktop adeguati; mobile/PC deboli attendono un’operazione esplicita | Su profili mobili emulati, picco dopo 3 s ridotto di ~144–146 MiB |
| Migrazione IndexedDB con `getAll()` degli audio; rename/save riscrivevano il Blob | Più audio contemporaneamente e I/O inutile anche per cambiare un nome/taglio | Migrazione con cursore in transazione atomica; rename solo metadati; save audio solo se cambiato | Due salvataggi consecutivi nel browser: una sola `put` nello store audio; rollback migration su quota insufficiente |
| Richieste IndexedDB accodate dopo await | Transazione potenzialmente inattiva in Safari | Tutte le letture accodate prima del primo await | Test del comportamento transazionale; Safari reale resta da verificare |
| Cleanup sbloccava il job prima del probe finale dei metadati | Un altro file/export poteva partire e poi ricevere lo stato della cleanup precedente | Lock fino a pubblicazione, probe annullabile su unmount e verifica dell’identità della sorgente | Prova browser con callback metadata ritardata: export e nuova cleanup restano disabilitati |
| Recorder e Wake Lock potevano completare dopo stop/unmount | Stream microfono/lock tardivi, chunk e callback di sessioni vecchie | Identità delle sessioni, deduplica delle richieste, rilascio dei risultati tardivi, pulizia chunk/listener/timer | Test stop/cancel/richiesta microfono tardiva e lock tardivo; callback Recorder stabilizzata |

## Ciclo di vita e complessità effettiva

| Fase | Gestione attuale | Memoria aggiuntiva da considerare |
|---|---|---|
| Selezione | Riferimento al File e object URL; nessun limite arbitrario a 100/150 MB | Il browser può usare cache/file mapping; File non significa zero RAM nativa |
| Metadati | HTMLAudio `preload=metadata`, oppure FFmpeg quando il browser non legge il formato | Elemento audio, URL, timer e listener liberati su successo/errore/abort |
| Anteprima piccola | WaveSurfer `loadBlob`, decoding integrale ammesso solo entro stima prudenziale | **O(file + PCM)**; non è streaming e non viene presentata come tale |
| Anteprima grande/lunga | HTMLAudio con URL del File | Nessun buffer JavaScript dell’intero audio; buffering nativo deciso dal browser |
| Input elaborazione | WORKERFS riusato per la sorgente attiva, smontato al cambio sorgente | Letture incrementali nel worker, senza copia integrale aggiuntiva dell’input in MEMFS |
| Codifica/filtri | Un job e un segmento alla volta nel worker | Stato del codec + **O(segment size)**; alcuni codec/container possono richiedere ulteriori strutture |
| Ricezione output dal worker | `readFile` restituisce il segmento e il file MEMFS viene eliminato subito | Una copia del segmento durante la lettura; nessuna concatenazione di tutte le parti |
| Cartella/ZIP su disco | Scrittura seriale con backpressure; byte consegnati alla destinazione progressivamente | **O(segment size + chunk ZIP)**; FFmpeg non produce ancora uno stream di output end-to-end |
| ZIP compatibile | BlobWriter STORE, entro budget totale | **O(archive size + segment size)**, anche se il browser può scaricare Blob su disco internamente |
| File singoli | Download nativo, URL temporanei; conservazione dei risultati entro budget | Blob del singolo risultato, rilasciato quando non conservato |
| Fine/errore/annullo/cambio file | Rimozione output virtuali, abort sink, reset worker morto, revoca URL e riferimenti | Il WASM heap non è garantito ridursi dopo `deleteFile`; terminate libera l’istanza |

Il vecchio helper `fileInput.js` prealloca o concatena l’intero input, ma **non è importato dal
flusso applicativo attivo**. Non è stato riscritto né usato per i file grandi. Più riferimenti allo
stesso Blob non sono automaticamente più copie dei byte: backup originale, object URL e
state conservano intenzionalmente la stessa sorgente per ripristino/ascolto. Sono invece stati
eliminati i riferimenti non necessari a vecchi mount, risultati e audio salvati al cambio sorgente.

## Budget adattivi

I valori sono in MiB; la UI usa l’etichetta MB per continuità. Non rappresentano RAM libera.

> **Aggiornamento 30/09/2026 (sera).** I budget iniziali (32 MiB per parte su mobile/tablet)
> bloccavano l’uso reale: una lezione da 160–180 MB divisa in due non si esportava più da tablet,
> mentre prima funzionava in ~3 minuti. Requisito di prodotto: **≥ 100 MB per parte su ogni
> dispositivo**. I budget ora dipendono solo dalla memoria dichiarata (`navigator.deviceMemory`),
> identici per telefono, tablet e desktop; il fallback MEMFS usa lo stesso budget di una parte.

| Memoria dichiarata | Singolo output | ZIP compatibile totale | Risultati conservati | Fallback input MEMFS |
|---|---:|---:|---:|---:|
| ≤ 2 GB (3 GB reali arrotondati a 2) | 160 | 256 | 256 | 160 |
| 4 GB oppure non dichiarata (Safari iPhone/iPad, Firefox) | 256 | 384 | 256 | 256 |
| ≥ 8 GB | 512 | 1024 | 512 | 512 |

Picco stimato di una parte ≈ 2,1× la sua dimensione (crescita MEMFS del 12,5% + copia di
`readFile`): 100 MB → ~210 MB transitori, 160 MiB → ~340 MiB. Lo ZIP compatibile resta sotto
384 MiB senza dato dichiarato perché WebKit può tenerne due copie durante `Response.blob()`.
Su mobile il wasm del motore viene scaricato in Cache Storage appena c’è un file, senza compilarlo
(nessun worker/heap residente): all’export resta solo la compilazione. Il link di download resta
valido 60 s (Safari e alcuni download manager leggono il Blob dopo il click).

Tabella originale, superata:

| Profilo | Singolo output | ZIP compatibile totale | Risultati conservati | Fallback input MEMFS |
|---|---:|---:|---:|---:|
| Mobile/tablet | 32 | 64 | 16 | 8 |
| Desktop ≤4 GiB dichiarati oppure ≤4 core | 64 | 128 | 32 | 8 |
| Altri desktop | 192 | 256 | 150 | 32 |

La guardia waveform stima `2 × input + 2 × PCM finale + 2 × PCM stereo a 48 kHz`, con soglie
128/256/512 MiB rispettivamente. Durata e dimensione contano entrambe: un M4A piccolo ma
lungo può costare più di un WAV breve. Memoria/core dichiarati, pointer e indicatori iOS/Android
servono per scegliere il profilo; non vengono trattati come misura affidabile della RAM disponibile.
Risparmio dati e reti 2G evitano preparazione anticipata. Non sono stati aggiunti worker paralleli,
hashing dell’intero audio o tuning dinamico dei chunk privo di misure.

Su browser senza picker filesystem, un ZIP troppo grande viene rifiutato con indicazione
di accorciare l’export o ridurre il bitrate. Aumentare le parti riduce il picco per segmento,
**non la dimensione totale dello ZIP**. Questa guardia è particolarmente rilevante su iOS,
dove il percorso dei download multipli è già convertito in ZIP compatibile.

## Misure prima/dopo

Prove locali con Chrome 153.0.8010.48, stesso host, profili freschi e WAV PCM16 stereo 44,1 kHz
da 25/100/250/500 **MiB**. I caricamenti usano silenzio valido; gli export usano 500 MiB di rumore
PCM deterministico (~49 min 32 s), quindi non un output artificialmente vuoto.
Baseline di produzione: commit `bc738908f995`, ricostruito in directory temporanea.

| Input | Anteprima prima → dopo | Pronto prima → dopo | Picco renderer RSS prima → dopo |
|---|---|---:|---:|
| 25 MiB | waveform → waveform | 301 → 282 ms | 843 → 801 MiB |
| 100 MiB | waveform → nativa | 440 → 76 ms | 1316 → 531 MiB (**−59,7%**) |
| 250 MiB | waveform → nativa | 992 → 77 ms | 2371 → 532 MiB (**−77,5%**) |
| 500 MiB | nativa → nativa | 77 → 75 ms | 534 → 529 MiB |

Il vantaggio su 100/250 MiB deriva dalla scelta dell’anteprima nativa, quindi include il
compromesso intenzionale di rinunciare alla waveform completa per quei file. Le differenze
piccole su 25/500 MiB non dimostrano da sole un miglioramento significativo. Sui file piccoli
la waveform resta disponibile. In sviluppo StrictMode le letture integrali da due diventano una;
in produzione da una a zero per i casi ora nativi.

RSS è la **somma campionata ogni 50 ms dei renderer dell’istanza Chrome isolata**: include
memoria nativa, WASM, eventuali processi spare, pagine condivise e file-backed potenzialmente
recuperabili. Non equivale allo heap JS, né al picco esatto della singola tab o alla memoria
non recuperabile. Sono singole prove, non percentili di un benchmark ripetuto. La misura parte
dopo la navigazione e termina al ready o al termine dell’attesa esplicita; non prova il consumo
durante un ascolto prolungato. `performance.memory` è registrato soltanto come dato accessorio:
può mancare, valere zero per mancato campione e sottostimare molto le allocazioni native.

Altre verifiche concluse:

- Profili Pixel 5 e iPhone 13 in **Chromium**, memoria/core dichiarati 2 GiB/2,
  main thread rallentato 4×: caricamenti delle quattro taglie senza errori e senza letture
  integrali dell’audio; anteprima nativa anche per il WAV 25 MiB. Pronto in ~242–351 ms.
- Dopo 3 s dal caricamento di 500 MiB: picco RSS mobile da ~646 MiB a ~502/500 MiB
  con warm-up rinviato. L’export esplicito continua a caricare il motore correttamente.
- Due export desktop consecutivi da 500 MiB: ~14,3–14,4 s nella prova con RSS;
  picchi cumulativi ~887 e ~908 MiB. Output invariati, niente errori pagina e nessun long task
  osservato durante questi export. Questo costo resta significativo per un telefono debole.
- Export dei profili mobili dopo rinvio del warm-up: ~15,1 s, ZIP validi; picchi ~861/886 MiB.
  La CPU throttling CDP non simula in modo affidabile la CPU del worker FFmpeg.
- Ogni ZIP contiene due M4A di 24.109.052 e 24.110.285 byte, CRC verificato;
  `ffprobe` nativo conferma AAC stereo 44,1 kHz e durata 1486,077 s per ciascuna parte.
- Export cartella ~14,3 s e ZIP su disco ~15,0 s con **FileSystem handles OPFS reali**;
  sostituiti solo i picker, nessun accesso a cartelle personali. Dimensioni/firme corrette.
- Annullamento di job FFmpeg reale e recupero della UI, rifiuto delle due parti WAV troppo
  grandi prima della codifica, salvataggi consecutivi con una sola scrittura audio.
- FFprobe nel worker reale con WMA non riproducibile dal browser: durata letta e controlli
  di export disponibili, senza errori pagina dopo introduzione della deadline.
- Long task iniziale ~97–116 ms ancora osservabile in alcune prove di caricamento/avvio:
  non viene affermata assenza di long task nell’intera piattaforma.
- Suite: **162 test passati** (inclusi quattro test della migrazione cache), build Vite/PWA riuscita, controllo whitespace e review indipendente
  dei percorsi preview, motore, storage, export e cleanup. Il repository non ha script lint/typecheck.

I JSON delle misure sono in `performance-results/`. Fixture e ZIP pesanti restano temporanei,
non entrano nel repository. La build aggiornata è in `docs/`, destinazione della distribuzione GitHub Pages da `main`.

## Preparazione alla pubblicazione e migrazione cache

Su richiesta di pubblicazione, Vite è stato aggiornato da 7.3.2 a 7.3.6 e le dipendenze
di build vulnerabili hanno ricevuto aggiornamenti compatibili nel lockfile.
`npm audit`: da 10 segnalazioni a **zero vulnerabilità note** al momento della verifica.
Le versioni runtime React, WaveSurfer, zip.js e FFmpeg rimangono identiche.

La nuova cache motore `audio-cutter-ffmpeg-wasm-v3` evita il riuso delle vecchie cache.
`cache-migration.js`, importato dal service worker generato, ripulisce le entry dell’app
nelle cache legacy all’**attivazione**, non durante l’installazione in attesa.
I progetti/audio IndexedDB e le preferenze rimangono; le entry di altre app sullo stesso
origin sono preservate. Workbox elimina gli asset precache superati.

Le vecchie schede possono attivare l’aggiornamento tramite «Ricarica ora», a lavoro finito,
oppure chiudendo e riaprendo l’app. Non si forza il reload di elaborazioni in corso.
Non è possibile cancellare da remoto la cache di un dispositivo offline: la migrazione
opera quando il dispositivo riceve e attiva il nuovo service worker. Questo segue il
[ciclo di aggiornamento Workbox](https://developer.chrome.com/docs/workbox/handling-service-worker-updates/).

Test aggiuntivo riproducibile, con una precedente build in una directory temporanea:

```bash
AUDIO_CUTTER_BASELINE_DIR=/percorso/precedente/docs \
AUDIO_CUTTER_PLAYWRIGHT=/percorso/playwright \
node scripts/cache-migration-audit.mjs
```

Il test usa una sola origine localhost e un aggiornamento PWA reale per controllare cache
legacy, asset obsoleti, audio salvato, preferenze e contenuti di un’altra app.
È passato sia il passaggio dalla baseline sia un secondo aggiornamento dal client nuovo.
Il vecchio client già installato genera un errore console perché chiamava `.catch()` sul
valore void di `messageSkipWaiting()`, pur inviando il messaggio di aggiornamento:
il nuovo `main.jsx` corregge questo uso dell’API e il secondo aggiornamento non genera errori.
Smoke test dopo gli aggiornamenti di build: due export 500 MiB, CRC ZIP,
annullamento, budget output e lock di finalizzazione cleanup passati.

## Rete, responsività e secondo audit

Non ci sono polling audio né richieste di upload. Download engine condiviso fra chiamanti,
progress download UI massimo ~8/s, export ~5/s, log tecnico ~2/s, playback ~4/s e timer ETA 1/s.
Il retry di rete è limitato, cancellabile e non concatena risposte Range incompatibili. La ripresa
del motore riguarda i byte già ricevuti **nella stessa sessione**, non un download persistente
attraverso reload. La cache evita di scaricare nuovamente il motore completo quando disponibile.

Il secondo audit ha ricontrollato mount/cambio sorgente, output parziali, limiti anche con
destinazione manuale e fallback iOS, decode non abortibile, writer ZIP in finalizzazione,
scrittura filesystem pendente, metadati dopo cleanup, sessioni Recorder, Wake Lock tardivo,
cache corrotta e transazioni IndexedDB. Ha individuato e corretto gli abort dei writer bloccati
e la race finale della cleanup. Nessuna riscrittura di FFmpeg, waveform o storage.

## Limiti e prove ancora necessarie

1. **Safari/WebKit e dispositivi fisici non sono stati testati.** L’emulazione iPhone in Chrome
   non valida jetsam iOS, limiti RAM della tab, decoder Safari, background/screen lock o cambio rete
   reale. Nessuna garanzia universale di export 500 MiB su Android economici o vecchi iPhone.
2. WORKERFS limita le copie dell’input, ma codec, demuxer e heap WASM possono comunque avere
   picchi elevati. Il limite output non è un limite assoluto del processo. FFmpeg.wasm documenta
   inoltre un limite massimo di 2 GB; non è stato aumentato. [FAQ FFmpeg.wasm](https://ffmpegwasm.netlify.app/docs/faq/).
3. Stime preview/output assumono configurazioni audio comuni; multicanale, alte frequenze,
   VBR e container insoliti richiedono prove aggiuntive. Non si legge l’intero input per costruire
   una stima esatta. Le guardie effettive sugli output restano attive.
4. La registrazione microfono conserva i chunk compressi fino allo stop: **O(recording size)**.
   Sono stati corretti i leak di sessione; registrazioni di ore non sono diventate streaming su disco.
   Una futura registrazione OPFS richiederebbe lavoro e validazione dedicati.
5. Il checkpoint cartella può saltare file già presenti/non vuoti; non verifica hash o identità
   del contenuto. Non è un protocollo di resume verificato del codec. Un OS close già iniziato
   non è necessariamente reversibile dall’abort; la UI evita comunque un successo dopo annullamento.
6. Il download con link Blob è delegato al browser: la pagina non offre progress di rete o retry
   dei suoi chunk. Cartella/ZIP su disco evita di ricostruire un risultato totale in JavaScript;
   il fallback compatibile rimane entro budget. ZIP STORE e scrittura non buffered sono coerenti
   con le [opzioni ufficiali zip.js](https://gildas-lormeau.github.io/zip.js/api/interfaces/ZipWriterConstructorOptions.html).
7. Non sono stati raccolti heap snapshot completi né eseguiti soak test di ore. Test deterministici
   coprono teardown e richieste tardive, ma non equivalgono a provare ogni leak su hardware reale.
   L’ErrorBoundary non può intercettare la terminazione della tab da parte del sistema operativo.

## Ripetere le prove

```bash
npm test
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

In un altro terminale, con Chrome e Playwright disponibili:

```bash
AUDIO_CUTTER_PLAYWRIGHT=/percorso/assoluto/playwright \
AUDIO_CUTTER_EXPORT=1 AUDIO_CUTTER_DISK=1 AUDIO_CUTTER_RSS=1 \
node scripts/performance-audit.mjs
```

Playwright è uno strumento di test, non una nuova dipendenza runtime. Variabili opzionali:
`AUDIO_CUTTER_PROFILES='desktop,Pixel 5,iPhone 13'`, `AUDIO_CUTTER_SIZES=25,100,250,500`,
`AUDIO_CUTTER_IDLE_MS=3000`, `AUDIO_CUTTER_AUDIT_DIR=/tmp/audio-audit`, `AUDIO_CUTTER_URL`.
Lo script crea WAV temporanei; con export crea anche 500 MiB di PCM rumoroso e risultati ZIP.
RSS usa CDP e `ps` su macOS/Linux; zero significa campione assente, non consumo nullo.

Per il prossimo collaudo fisico: quattro taglie su Android 2/4 GiB, iPhone/iPad di generazioni
diverse, Safari desktop e PC 4 GiB; un file alla volta, ascolto prolungato, dieci operazioni
consecutive, background/foreground, annullo durante codifica e scrittura, spazio disco/quota
esauriti, rete interrotta durante il motore e reload. Rilevare RSS/allocazioni native quando
accessibili, long task, tempo al primo progresso, recupero dopo annullo e memoria dopo GC.
