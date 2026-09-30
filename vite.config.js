import { copyFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Peso esatto del wasm del motore: la barra di download resta precisa anche
// quando il server comprime la risposta (content-length ≠ byte decompressi).
function ffmpegWasmBytes() {
  try {
    const require = createRequire(import.meta.url);
    const corePath = require.resolve('@ffmpeg/core');
    return statSync(corePath.replace(/ffmpeg-core\.js$/, 'ffmpeg-core.wasm')).size;
  } catch {
    return 32 * 1024 * 1024;
  }
}

// GitHub Pages: 404.html = index.html (fallback SPA). emptyOutDir la cancella
// a ogni build: rigenerarla qui evita di perderla nei deploy.
function githubPages404() {
  let outDir = 'docs';
  return {
    name: 'github-pages-404',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const index = join(outDir, 'index.html');
      if (existsSync(index)) {
        copyFileSync(index, join(outDir, '404.html'));
      }
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __FFMPEG_WASM_BYTES__: JSON.stringify(ffmpegWasmBytes()),
  },
  // Il pre-bundle di Vite sposta @ffmpeg/ffmpeg in .vite/deps ma non il suo
  // worker: in dev il worker non si carica e ffmpeg.load() resta appeso.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  plugins: [
    react(),
    githubPages404(),
    VitePWA({
      // 'prompt': il nuovo SW resta in attesa finché l'utente preme "Ricarica ora"
      // (autoUpdate ricaricherebbe da solo, anche mentre si taglia audio).
      registerType: 'prompt',
      // Registrazione manuale in main.jsx (banner "Ricarica ora" invece di
      // reload a sorpresa): evita la doppia registrazione di registerSW.js.
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      workbox: {
        importScripts: ['./cache-migration.js'],
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              // New namespace invalidates the legacy engine cache on devices
              // when this PWA activates; migration preserves other apps/data.
              cacheName: 'audio-cutter-ffmpeg-wasm-v3',
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
