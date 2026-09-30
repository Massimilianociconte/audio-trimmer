import { isFfmpegProgressLine, parseFfmpegProgressSeconds } from './progress.js';
import { createActivityWatch, withActiveTimeout } from './activityWatch.js';

// Metadata probes do not emit periodic progress. A dead worker must still
// release the UI; preserve the core's -1 exit code for successful probes.
// La scadenza conta solo il tempo attivo: una scheda sospesa non è un worker morto.
export async function runFfprobe(ffmpeg, args, { timeoutMs = 120000 } = {}) {
  try {
    return await withActiveTimeout(
      ffmpeg.ffprobe(args),
      timeoutMs,
      'Il motore non risponde durante la lettura dei metadati. Riprova il motore o usa un file più piccolo.',
    );
  } catch (error) {
    if (error?.isTimeout) {
      try { ffmpeg.terminate(); } catch { /* already terminated */ }
    }
    throw error;
  }
}

export async function runFfmpeg(ffmpeg, args, { durationSeconds = 0, onProgress = null, captureLog = false, maxLogBytes = 1024 * 1024, maxOutputBytes = 0, stallTimeoutMs = 120000 } = {}) {
  const logs = [];
  const tail = [];
  let lastSeconds = -1;
  let watch = null;
  let lastReportAt = -Infinity;
  let logBytes = 0;
  let logOverflow = false;
  const report = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds <= lastSeconds) {
      return;
    }
    const now = performance.now();
    if (now - lastReportAt < 200 && !(durationSeconds > 0 && seconds >= durationSeconds)) return;
    lastReportAt = now;
    lastSeconds = seconds;
    if (typeof onProgress === 'function') {
      const frac = durationSeconds > 0 ? Math.min(1, seconds / durationSeconds) : null;
      try {
        onProgress(frac, seconds);
      } catch {
        // il reporting non deve mai rompere l'esecuzione
      }
    }
  };
  const onLog = ({ message }) => {
    watch?.touch();
    if (typeof message !== 'string') {
      return;
    }
    const seconds = parseFfmpegProgressSeconds(message);
    if (seconds !== null) {
      report(seconds);
      return;
    }
    if (isFfmpegProgressLine(message)) {
      return;
    }
    if (captureLog && (typeof captureLog !== 'function' || captureLog(message))) {
      logBytes += message.length * 2;
      if (logBytes <= maxLogBytes) logs.push(message);
      else logOverflow = true;
    }
    tail.push(message);
    if (tail.length > 30) {
      tail.shift();
    }
  };
  const onProgressEvent = ({ time }) => {
    watch?.touch();
    const micros = Number(time);
    if (Number.isFinite(micros) && micros >= 0) {
      report(micros / 1e6);
    }
  };
  const fullArgs = args.includes('-progress') ? [...args] : ['-progress', 'pipe:1', ...args];
  if (!fullArgs.includes('-nostats')) {
    fullArgs.unshift('-nostats');
  }
  // Il livello di log è globale nel modulo wasm: un `ffprobe -v error`
  // precedente lo lascia a "error" e sparirebbero i log info (silencedetect,
  // Duration/Stream di `ffmpeg -i`). Va reimpostato a ogni esecuzione.
  if (!fullArgs.includes('-loglevel') && !fullArgs.includes('-v')) {
    fullArgs.unshift('-loglevel', 'info');
  }
  if (maxOutputBytes > 0 && !fullArgs.includes('-fs')) {
    fullArgs.splice(fullArgs.length - 1, 0, '-fs', String(maxOutputBytes));
  }
  ffmpeg.on('log', onLog);
  ffmpeg.on('progress', onProgressEvent);
  // Inattività misurata solo in tempo ATTIVO: su telefono/iPad cambiare app o
  // bloccare lo schermo sospende il worker, non lo uccide. Al ritorno l'export
  // riprende invece di fallire.
  const stalled = new Promise((_, reject) => {
    watch = createActivityWatch({
      limitMs: stallTimeoutMs,
      onExpire: () => {
        reject(new Error('Il motore si è bloccato (probabilmente memoria piena). Chiudi le altre app o schede e riprova, oppure dividi in parti più corte.'));
        try { ffmpeg.terminate(); } catch { /* already terminated */ }
      },
    });
  });
  try {
    const exitCode = await Promise.race([ffmpeg.exec(fullArgs), stalled]);
    if (logOverflow) throw new Error('Il log di analisi ha raggiunto il limite di memoria: analizza un intervallo più breve.');
    return { exitCode, logText: logs.join('\n'), tailText: tail.join('\n') };
  } finally {
    watch?.stop();
    ffmpeg.off('log', onLog);
    ffmpeg.off('progress', onProgressEvent);
  }
}
