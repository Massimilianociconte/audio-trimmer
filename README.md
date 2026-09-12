# Audio Cutter

Web app statica per tagliare file audio direttamente nel browser, senza ri-upload e con download finale di tutte le parti già rinominate.

## Cosa fa

- carica un file audio una sola volta (drag & drop, registrazione microfono, progetti IndexedDB)
- divide in parti uguali oppure in segmenti personalizzati (testo, slider, drag su waveform, doppio click, auto da silenzi)
- esporta in M4A / MP3 / OGG / WAV con bitrate a scelta, fade in/out e modalità taglio veloce senza ricodifica
- scarica un unico ZIP con tutte le parti + riscarica i singoli senza ri-encoding
- nomi parti personalizzabili, anteprima ascolto per segmento, undo tagli (Ctrl+Z), ordinamento e pulizia duplicati
- mantiene il workflow locale nel browser, PWA leggera (WASM in runtime cache, precache ~0.5 MB)
- pulizia voce (lecture/podcast/memo/deep), loop A-B, segnalibri, export leggero per AI Studio
- export selezione A-B come file unico, copia scaletta capitoli mm:ss per YouTube, import tagli da scaletta incollata o da segnalibri
- progetto esportabile/importabile in JSON leggero (senza audio), libreria con rinomina e duplicazione
- undo tagli (Ctrl+Z), preferenze export persistenti, retry dopo errore, guardie su file enormi e quota IndexedDB
- architettura anti-OOM: export streaming su cartella (File System Access) o ZIP su disco (@zip.js/zip.js),
  mai più di un segmento in RAM, advisor automatico della destinazione, Wake Lock + checkpoint di ripresa
  per progetti pesanti in background, libreria IndexedDB con metadati separati dai blob audio

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

1. esegui `npm run build`
2. fai commit anche della cartella `docs/`
3. in GitHub vai su `Settings > Pages`
4. come source seleziona `Deploy from a branch`
5. imposta branch `main` e cartella `/docs`
