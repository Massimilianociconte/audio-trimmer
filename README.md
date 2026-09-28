# Audio Cutter

Web app statica per tagliare file audio direttamente nel browser, senza ri-upload e con download finale di tutte le parti già rinominate.

## Cosa fa

- carica un file audio una sola volta (drag & drop, registrazione microfono, progetti IndexedDB)
- divide in parti uguali oppure in segmenti personalizzati (testo, slider, drag su waveform, doppio click, auto da silenzi)
- esporta in M4A / MP3 / OGG / WAV / FLAC con bitrate a scelta, fade in/out e taglio veloce senza ricodifica (predefinito quando possibile)
- scarica un unico ZIP con tutte le parti + riscarica i singoli senza ri-encoding
- nomi parti personalizzabili, anteprima ascolto per segmento, undo tagli (Ctrl+Z), ordinamento e pulizia duplicati
- mantiene il workflow locale nel browser, PWA leggera (WASM in runtime cache, precache ~0.5 MB)
- pulizia audio professionale (lezione, podcast, memo da telefono, rumore forte, solo volume) con
  anteprima A/B di 20 s, opzione "accorcia pause", loop A-B, segnalibri, export leggero per AI Studio
- export selezione A-B come file unico, copia scaletta capitoli mm:ss per YouTube, import tagli da scaletta incollata o da segnalibri
- progetto esportabile/importabile in JSON leggero (senza audio), libreria con rinomina e duplicazione
- undo tagli (Ctrl+Z), preferenze export persistenti, retry dopo errore, guardie su file enormi e quota IndexedDB
- architettura anti-OOM: export streaming su cartella (File System Access) o ZIP su disco (@zip.js/zip.js),
  mai più di un segmento in RAM, advisor automatico della destinazione, Wake Lock + checkpoint di ripresa
  per progetti pesanti in background, libreria IndexedDB con metadati separati dai blob audio

## Prestazioni (telefoni, tablet, PC di fascia bassa)

- **file pronto subito**: se il browser legge il formato (MP3, M4A, WAV, OGG…) ascolto, forma d'onda
  e tagli sono disponibili in meno di un secondo, senza aspettare il motore
- **motore in background**: il wasm FFmpeg (32 MB) si scarica mentre si ascolta e si segnano i tagli,
  con percentuale, MB, velocità e tempo rimanente reali; dalla seconda visita arriva dalla cache
- **taglio senza ricodifica di default** per sorgenti MP3/M4A/AAC: qualità identica, decine di volte
  più veloce della conversione (precisione al frame, ~0,03 s); «Converti» resta a un clic
- **zero copie in memoria**: l'audio viene montato nel motore via WORKERFS invece di essere letto
  per intero in RAM e ricopiato nella memoria wasm
- **avanzamento reale** su export, silenzi, pulizia e copia per AI (`-progress pipe:1`): percentuale,
  velocità "× tempo reale", ETA, stato di ogni parte, pannello fisso sempre visibile, annulla immediato
- AAC con coder `fast` (2-9× più veloce del `twoloop` nel core single-thread), stima dei tempi
  imparata dalle esportazioni precedenti sul dispositivo
- UI leggera: niente blur animati/`backdrop-filter`, aggiornamenti del tempo di riproduzione
  limitati a 4/s, timeline della forma d'onda adattiva e vista iniziale "adatta alla larghezza"
- forma d'onda decodificata a 3 kHz su telefoni/tablet/PC deboli (PCM −62%): disegnata su lezioni
  ~2,7× più lunghe prima di ripiegare sull'anteprima nativa; ricaduta automatica a 8 kHz dove non supportato

## Pulizia audio: come è tarata

Catena per la voce: mono → taglio rombo 90 Hz → livellatore lento (~25 s: porta qualunque
registrazione, anche bassissima, a un livello standard, così tutte le soglie successive diventano
relative) → denoise spettrale adattivo (`afftdn` con tracciamento del rumore) → EQ anti-rimbombo
(−2 dB a 250 Hz) e presenza (+2,5 dB a 3,2 kHz) → de-esser → livellatore veloce con soglia (voce
vicina/lontana, senza gonfiare il rumore nelle pause lunghe) → expander sulle pause → compressore
2,5:1 → limiter + guadagno calibrato.

Misure oggettive (EBU R128 / RMS) su registrazioni di prova rumorose, molto basse e con clipping:

| | originale | dopo "Lezione in aula" |
|---|---|---|
| loudness integrata | da −38,8 a −12,7 LUFS | −16,1 … −16,4 LUFS |
| picco reale | fino a +1,8 dBTP (clipping) | ≤ −3,8 dBTP |
| rumore nelle pause (SNR) | 31–35 dB | 46–52 dB |
| scarto voce vicina/lontana | 11,5–11,8 dB | 0,3–0,8 dB |
| rumore in una pausa di 10 s | −54 dB | −69,7 dB (anche su registrazione a −49 dB) |

Lo stadio finale limiter+guadagno sostituisce `loudnorm` (stesso risultato, 5× più veloce nel core
wasm perché `loudnorm` ricampiona a 192 kHz). Tutti i preset sono validati nel core wasm reale
(FFmpeg 5.1): output entro 0,1 dB dal nativo, ~100× tempo reale su desktop, nessun leak di memoria
su 30 esecuzioni consecutive. Senza "accorcia pause" la durata non cambia e tagli/segnalibri restano validi.

## Sviluppo locale

```bash
npm install
npm run dev
```

## Build produzione

```bash
npm run build
```

## Deploy su GitHub Pages

Il build di produzione viene generato nella cartella `docs/`, pensata apposta per GitHub Pages.

1. esegui `npm run build` (rigenera anche `docs/404.html` per il fallback SPA)
2. fai commit anche della cartella `docs/`
3. in GitHub vai su `Settings > Pages`
4. come source seleziona `Deploy from a branch`
5. imposta branch `main` e cartella `/docs`
