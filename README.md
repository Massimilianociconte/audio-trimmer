# Audio Cutter

Web app statica per tagliare file audio direttamente nel browser, senza ri-upload e con download finale di tutte le parti già rinominate.

## Cosa fa

- carica un file audio una sola volta
- divide in parti uguali oppure in segmenti personalizzati
- esporta tutte le parti in un solo ZIP
- mantiene il workflow locale nel browser
- usa copia diretta dei flussi quando il formato lo permette, evitando ricodifiche inutili

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
