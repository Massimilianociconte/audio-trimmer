import { cpuCores, deviceMemoryGB, isAndroid, isSaveData } from './device.js';

/**
 * Conversioni in parallelo su tablet/telefoni Android capaci.
 *
 * Gli encoder audio di FFmpeg sono single-thread: la conversione usa un solo
 * core anche su un tablet con 8. Due motori (core wasm single-thread, ognuno
 * nel suo worker) creano due parti alla volta. Ogni parte esce identica byte
 * per byte (stessi comandi, motori indipendenti); misurato: 1,9-2× più veloce
 * con 2 motori, ~150-220 MiB in più durante l'export.
 *
 * Il consumo (ZIP, salvataggi per la ripresa, download) resta sequenziale e
 * nell'ordine delle parti: la coda prepara solo la parte successiva.
 */

const PARALLEL_FORMATS = new Set(['m4a', 'mp3', 'ogg']);
export const PARALLEL_MIN_MEMORY_GB = 8;
export const PARALLEL_MIN_CORES = 8;
const PARALLEL_ENGINES = 2;

/**
 * Motori da usare per creare le parti: 2 oppure 1 (flusso sequenziale).
 * 2 solo se: Android, 8 GB dichiarati (massimo esposto da Chrome Android) e
 * almeno 8 core, niente risparmio dati, conversione (non taglio senza
 * ricodifica) in un formato compresso, almeno 2 parti da creare, e due uscite
 * stanno nel budget di memoria di UNA parte.
 */
export function exportEngineCount({
  fastCopy = false,
  formatId = '',
  pendingParts = 0,
  maxPartBytes = 0,
  segmentBudgetBytes = 0,
  destMode = '',
} = {}, env = globalThis) {
  if (fastCopy || !PARALLEL_FORMATS.has(formatId) || destMode === 'folder') return 1;
  if (!(Number(pendingParts) >= 2)) return 1;
  if (!isAndroid(env) || isSaveData(env)) return 1;
  if (!(deviceMemoryGB(env) >= PARALLEL_MIN_MEMORY_GB) || !(cpuCores(env) >= PARALLEL_MIN_CORES)) return 1;
  const part = Number(maxPartBytes);
  const budget = Number(segmentBudgetBytes);
  if (!(part > 0) || !(budget > 0) || part * PARALLEL_ENGINES > budget) return 1;
  return PARALLEL_ENGINES;
}

/**
 * Coda di creazione con anticipo. `take(index)` consegna le parti nell'ordine
 * richiesto da chi consuma; nel frattempo i motori liberi preparano le parti
 * successive del piano. Al massimo tante parti vive quanti motori: una parte
 * preparata resta in memoria finché non viene chiesta la successiva.
 *
 * - `encode(lane, index)` crea la parte `index` sul motore `lane`.
 * - Un motore aggiuntivo che fallisce viene chiuso (`lane.kill`) e la parte
 *   rifatta sul principale: stesso risultato, solo più lento.
 * - Un errore del principale arriva a chi consuma, senza ripetizioni.
 * - Annullato o chiuso: nessun nuovo lavoro, nessuna ripetizione.
 */
export function createEncodeAhead({ plan = [], encode, isAborted = () => false, onStart = null } = {}) {
  const order = [...plan];
  const lanes = [];
  const jobs = new Map();
  let head = -Infinity;
  let disposed = false;
  let parallelUsed = false;

  const stopped = () => disposed || Boolean(isAborted());
  const live = () => lanes.filter((lane) => !lane.dead);
  const mainLane = () => lanes.find((lane) => lane.main && !lane.dead) ?? null;
  const idle = (lane) => !lane.dead && lane.pending === 0;

  function runOn(lane, index) {
    lane.pending += 1;
    const task = lane.tail.then(() => encode(lane, index));
    lane.tail = task.then(() => {}, () => {});
    return task.finally(() => {
      lane.pending -= 1;
      schedule();
    });
  }

  function start(index, lane) {
    if (lanes.some((other) => other !== lane && other.pending > 0)) parallelUsed = true;
    try {
      onStart?.(index, lane);
    } catch {
      // l'avanzamento non deve mai fermare il lavoro
    }
    const promise = (async () => {
      try {
        return await runOn(lane, index);
      } catch (error) {
        if (lane.main || stopped()) throw error;
        lane.dead = true;
        try {
          lane.kill?.();
        } catch {
          // già chiuso
        }
        const main = mainLane();
        if (!main) throw error;
        return runOn(main, index);
      }
    })();
    // Una parte preparata e mai chiesta (errore altrove, annullo) non deve
    // diventare un rifiuto non gestito.
    promise.catch(() => {});
    jobs.set(index, { promise });
  }

  function schedule() {
    if (stopped()) return;
    const limit = live().length;
    for (const index of order) {
      if (jobs.size >= limit) return;
      if (index < head || jobs.has(index)) continue;
      const lane = live().find(idle);
      if (!lane) return;
      start(index, lane);
    }
  }

  return {
    addLane(lane) {
      if (disposed) {
        // Motore arrivato a export finito: niente lavoro, si chiude subito.
        try {
          lane.kill?.();
        } catch {
          // già chiuso
        }
        return;
      }
      lanes.push({ ...lane, dead: false, pending: 0, tail: Promise.resolve() });
      schedule();
    },
    take(index) {
      if (disposed) return Promise.reject(new Error('Coda di export chiusa.'));
      // La parte consegnata prima è stata consumata: libera il posto.
      for (const key of [...jobs.keys()]) {
        if (key < index) jobs.delete(key);
      }
      head = index;
      if (!jobs.has(index)) {
        const lane = live().find(idle) ?? mainLane() ?? live()[0];
        if (!lane) return Promise.reject(new Error('Nessun motore disponibile per l’export.'));
        start(index, lane);
      }
      schedule();
      const job = jobs.get(index);
      const { promise } = job;
      if (!promise) return Promise.reject(new Error(`Parte ${index + 1} già consegnata.`));
      // Il risultato vive solo in chi lo consuma: niente seconda copia trattenuta qui.
      job.promise = null;
      return promise;
    },
    dispose() {
      disposed = true;
      jobs.clear();
    },
    laneCount: () => live().length,
    usedParallel: () => parallelUsed,
    mainBusy: () => lanes.some((lane) => lane.main && lane.pending > 0),
  };
}
