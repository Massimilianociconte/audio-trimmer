/**
 * Worker FFmpeg per telefoni e tablet: è il worker ufficiale di
 * @ffmpeg/ffmpeg (importato così com'è) con due estensioni per le uscite:
 * preassegnazione della dimensione prevista e consegna senza copia.
 * Vedi src/lib/outputTransfer.js. I desktop usano il worker originale.
 */
import '@ffmpeg/ffmpeg/worker';
import { handleOutputMessage, installOutputPatches } from '../lib/outputTransfer.js';

const hints = new Map();
let core = null;
let createCore;

// Il worker originale assegna self.createFFmpegCore dopo l'import del core:
// lo si avvolge per applicare le estensioni all'istanza appena creata.
Object.defineProperty(self, 'createFFmpegCore', {
  configurable: true,
  get: () => createCore,
  set(factory) {
    createCore = typeof factory === 'function'
      ? async (...args) => {
        const instance = await factory(...args);
        try {
          core = installOutputPatches(instance, hints) ? instance : null;
        } catch {
          core = null;
        }
        return instance;
      }
      : factory;
  },
});

const libraryOnMessage = self.onmessage;
self.onmessage = (event) => {
  const handled = handleOutputMessage(event.data, {
    core,
    hints,
    post: (message, transfer = []) => self.postMessage(message, transfer),
  });
  if (!handled && typeof libraryOnMessage === 'function') {
    return libraryOnMessage.call(self, event);
  }
  return undefined;
};
