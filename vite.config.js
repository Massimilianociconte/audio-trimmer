import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt': il nuovo SW resta in attesa finché l'utente preme "Ricarica ora"
      // (autoUpdate ricaricherebbe da solo, anche mentre si taglia audio).
      registerType: 'prompt',
      // Registrazione manuale in main.jsx (banner "Ricarica ora" invece di
      // reload a sorpresa): evita la doppia registrazione di registerSW.js.
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              // Nome versionato: un wasm tronco in cache non deve sopravvivere
              // ai deploy (bump v2→v3 quando cambia @ffmpeg/core).
              cacheName: 'ffmpeg-wasm-v2',
              expiration: {
                maxEntries: 4,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
              cacheableResponse: {
                // Solo 200 piene: mai risposte opache/troncate (niente status 0).
                statuses: [200],
              },
            },
          },
        ],
      },
      manifest: {
        id: './',
        lang: 'it',
        dir: 'ltr',
        categories: ['education', 'music', 'utilities'],
        name: 'Audio Cutter per studenti',
        short_name: 'Audio Cutter',
        description:
          'Taglia lezioni e registrazioni audio direttamente nel browser, offline e senza upload.',
        theme_color: '#ef6c2f',
        background_color: '#fff5ee',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'favicon.svg',
            sizes: '192x192 512x512',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'favicon.svg',
            sizes: '192x192 512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
});
