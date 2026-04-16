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

Il repository include già il workflow [`deploy.yml`](./.github/workflows/deploy.yml).

1. carica il progetto su GitHub
2. assicurati che il branch principale sia `main`
3. in GitHub vai su `Settings > Pages`
4. come source seleziona `GitHub Actions`
5. ogni push su `main` pubblicherà automaticamente il sito
