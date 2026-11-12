/**
 * Export riprendibili su telefoni e tablet.
 *
 * Nessuna API web garantisce che il lavoro continui con l'app in secondo
 * piano: iPadOS sospende Safari dopo pochi secondi, Chrome Android congela
 * pagina e worker (1 minuto dalla versione 139) e il sistema può chiudere
 * la scheda per liberare memoria. Qui si rende l'export riprendibile:
 * - ogni parte completata viene salvata subito in IndexedDB (ZIP) oppure
 *   segnata come già scaricata (file singoli);
 * - «Riprova» o un nuovo «Taglia e scarica» con lo stesso file e gli stessi
 *   tagli riusa le parti pronte e riparte dalla prima mancante;
 * - dopo una chiusura della scheda i tagli si ripristinano riaprendo il file.
 *
 * Database separato da quello dei progetti: nessuna migrazione da toccare.
 * Tutto è best effort: un errore di salvataggio non ferma mai l'export.
 */

import { withActiveTimeout } from './activityWatch.js';

const DB_NAME = 'audio-cutter-export-jobs';
const DB_VERSION = 1;
const STORE_JOBS = 'jobs';
const STORE_PARTS = 'parts';
// Oltre questa età un export interrotto non viene più proposto.
export const JOB_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Sotto questa stima di lavoro ripartire da capo costa meno che salvare.
export const PERSIST_MIN_WORK_SECONDS = 15;
// Ogni operazione IndexedDB ha una scadenza (tempo attivo): un database
// bloccato (es. Safari al ritorno dal background) non deve fermare l'export.
const OP_TIMEOUT_MS = 20000;
const QUOTA_MARGIN = 1.25;
const QUOTA_RESERVE_BYTES = 32 * 1024 * 1024;

function round3(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
}

/** Identità del file sorgente: basta per riconoscerlo dopo un ricaricamento. */
export function sourceIdentity(audio) {
  return {
    name: String(audio?.name ?? ''),
    size: Number(audio?.size) || 0,
    lastModified: Number.isFinite(Number(audio?.lastModified)) ? Number(audio.lastModified) : null,
    duration: round3(audio?.duration),
  };
}

export function sameSource(left, right) {
  if (!left || !right) return false;
  const a = sourceIdentity(left);
  const b = sourceIdentity(right);
  if (!a.name || a.name !== b.name || a.size !== b.size || a.size <= 0) return false;
  if (a.lastModified !== null && b.lastModified !== null && a.lastModified !== b.lastModified) return false;
  return Math.abs(a.duration - b.duration) < 0.05;
}

/**
 * Impronta del lavoro: stessa sorgente, stessi tagli, stesse impostazioni
 * audio ⇒ stesse parti. I nomi dei file non contano (si rinomina senza
 * ricodificare).
 */
export function exportJobFingerprint({ source, segments, formatId, bitrateKbps, fastCopy, fadeSeconds, outputExtension }) {
  const identity = sourceIdentity(source);
  return JSON.stringify({
    v: 1,
    source: [identity.name, identity.size, identity.lastModified, identity.duration],
    segments: (segments ?? []).map((segment) => [round3(segment.start), round3(segment.duration)]),
    format: String(formatId ?? ''),
    bitrate: fastCopy ? 0 : Number(bitrateKbps) || 0,
    fastCopy: Boolean(fastCopy),
    fade: fastCopy ? 0 : round3(fadeSeconds),
    ext: String(outputExtension ?? ''),
  });
}

/**
 * Cosa salvare per questo export:
 * - 'blobs': le parti stesse (ZIP in memoria: senza salvataggio una scheda
 *   chiusa perde tutto);
 * - 'delivery': solo quali parti sono già state scaricate (file singoli:
 *   sono già nella cartella Download, niente doppioni alla ripresa);
 * - null: niente (desktop, destinazioni su disco, lavori brevi).
 */
export function exportPersistenceMode({ mobile, destMode, estimatedWorkSeconds = 0 }) {
  if (!mobile) return null;
  if (destMode === 'singles') return 'delivery';
  if (destMode === 'zip-classic' && Number(estimatedWorkSeconds) >= PERSIST_MIN_WORK_SECONDS) return 'blobs';
  return null;
}

/** Spazio sufficiente per salvare `bytes`? Senza stima disponibile: sì. */
export async function hasStorageRoomFor(bytes, storage = globalThis.navigator?.storage) {
  try {
    if (typeof storage?.estimate !== 'function') return true;
    const { quota, usage } = await storage.estimate();
    if (!Number.isFinite(quota) || !Number.isFinite(usage)) return true;
    return quota - usage >= bytes * QUOTA_MARGIN + QUOTA_RESERVE_BYTES;
  } catch {
    return true;
  }
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Transazione IndexedDB annullata.'));
    tx.onerror = () => reject(tx.error ?? new Error('Transazione IndexedDB non riuscita.'));
  });
}

function partKey(jobId, index) {
  return `${jobId}:${index}`;
}

function generateJobId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Store dei job. `indexedDB`, `now` e `timeoutMs` sono iniettabili per i test.
 * Nessun metodo lancia: in caso di problemi ritorna null/false e il
 * chiamante prosegue senza salvataggio.
 */
export function createExportJobStore({
  indexedDB = globalThis.indexedDB,
  dbName = DB_NAME,
  now = () => Date.now(),
  timeoutMs = OP_TIMEOUT_MS,
} = {}) {
  let dbPromise = null;

  const open = () => {
    if (!indexedDB || typeof indexedDB.open !== 'function') {
      return Promise.reject(new Error('IndexedDB non disponibile.'));
    }
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_JOBS)) {
            db.createObjectStore(STORE_JOBS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_PARTS)) {
            const parts = db.createObjectStore(STORE_PARTS, { keyPath: 'key' });
            parts.createIndex('jobId', 'jobId');
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          // Connessione persa (Safari dopo il background) o nuova versione:
          // la prossima operazione riapre.
          db.onclose = () => { dbPromise = null; };
          db.onversionchange = () => {
            try { db.close(); } catch { /* ignore */ }
            dbPromise = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Database export bloccato da un’altra scheda.'));
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  };

  // Ogni operazione: scadenza in tempo attivo e connessione da riaprire
  // dopo un errore. Ritorna `fallback` invece di lanciare.
  const guarded = async (operation, fallback) => {
    try {
      return await withActiveTimeout(
        (async () => operation(await open()))(),
        timeoutMs,
        'IndexedDB non risponde.',
      );
    } catch {
      dbPromise = null;
      return fallback;
    }
  };

  // Elimina job e parti, tranne `keepId`. Tutte le richieste partono prima di
  // qualunque await (transazioni Safari).
  const deleteJobs = (db, { keepId = null } = {}) => {
    const tx = db.transaction([STORE_JOBS, STORE_PARTS], 'readwrite');
    const done = waitForTransaction(tx);
    const jobs = tx.objectStore(STORE_JOBS);
    const parts = tx.objectStore(STORE_PARTS);
    const cursorRequest = jobs.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if (cursor.value?.id !== keepId) {
        cursor.delete();
      }
      cursor.continue();
    };
    const partsRequest = parts.openCursor();
    partsRequest.onsuccess = () => {
      const cursor = partsRequest.result;
      if (!cursor) return;
      if (cursor.value?.jobId !== keepId) {
        cursor.delete();
      }
      cursor.continue();
    };
    return done;
  };

  const readAllJobs = async (db) => {
    const tx = db.transaction(STORE_JOBS, 'readonly');
    return promisifyRequest(tx.objectStore(STORE_JOBS).getAll());
  };

  return {
    /** Job interrotto più recente (non scaduto), oppure null. */
    async getPending() {
      return guarded(async (db) => {
        const jobs = await readAllJobs(db);
        const fresh = jobs
          .filter((job) => job && now() - (job.updatedAt ?? 0) <= JOB_MAX_AGE_MS)
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
        const keep = fresh[0] ?? null;
        if (jobs.length > (keep ? 1 : 0)) {
          await deleteJobs(db, { keepId: keep?.id ?? null });
        }
        return keep;
      }, null);
    },

    /**
     * Apre (o riprende, se l'impronta coincide) il job. Un job diverso
     * viene eliminato con le sue parti: se ne tiene uno solo.
     */
    async begin({ fingerprint, persist, source, ui, settings, names, total, destMode }) {
      return guarded(async (db) => {
        const jobs = await readAllJobs(db);
        const existing = jobs.find((job) => job?.fingerprint === fingerprint
          && job.persist === persist
          && now() - (job.updatedAt ?? 0) <= JOB_MAX_AGE_MS);
        await deleteJobs(db, { keepId: existing?.id ?? null });
        const job = existing
          ? { ...existing, ui, settings, names, destMode, updatedAt: now() }
          : {
            id: generateJobId(),
            fingerprint,
            persist,
            source: sourceIdentity(source),
            ui,
            settings,
            names,
            total,
            destMode,
            done: {},
            createdAt: now(),
            updatedAt: now(),
          };
        const tx = db.transaction(STORE_JOBS, 'readwrite');
        const written = waitForTransaction(tx);
        tx.objectStore(STORE_JOBS).put(job);
        await written;
        return job;
      }, null);
    },

    /** Blob di una parte salvata, oppure null. */
    async loadPart(jobId, index) {
      return guarded(async (db) => {
        const tx = db.transaction(STORE_PARTS, 'readonly');
        const record = await promisifyRequest(tx.objectStore(STORE_PARTS).get(partKey(jobId, index)));
        return record?.blob instanceof Blob && record.blob.size > 0 ? record.blob : null;
      }, null);
    },

    /**
     * Segna una parte come pronta; con `blob` la salva anche. Una sola
     * transazione: parte e stato del job restano coerenti.
     */
    async savePart(jobId, index, { blob = null, name, size, duration, delivered = false }) {
      return guarded(async (db) => {
        const stores = blob ? [STORE_JOBS, STORE_PARTS] : [STORE_JOBS];
        const tx = db.transaction(stores, 'readwrite');
        const written = waitForTransaction(tx);
        if (blob) {
          tx.objectStore(STORE_PARTS).put({ key: partKey(jobId, index), jobId, index, blob });
        }
        const jobs = tx.objectStore(STORE_JOBS);
        const request = jobs.get(jobId);
        let found = false;
        request.onsuccess = () => {
          const job = request.result;
          if (!job) {
            // Job scartato nel frattempo: niente parte orfana.
            tx.abort();
            return;
          }
          found = true;
          job.done = { ...(job.done ?? {}), [index]: { name, size, duration, stored: Boolean(blob), delivered } };
          job.updatedAt = now();
          jobs.put(job);
        };
        try {
          await written;
        } catch (error) {
          if (!found) return false;
          throw error;
        }
        return true;
      }, false);
    },

    /** Elimina tutti i job (export completato, annullato o scartato). */
    async discard() {
      return guarded(async (db) => {
        await deleteJobs(db);
        return true;
      }, false);
    },
  };
}

/** Parti già pronte di un job, nell'ordine: [{ index, name, size, duration, stored, delivered }]. */
export function completedParts(job) {
  const done = job?.done && typeof job.done === 'object' ? job.done : {};
  return Object.entries(done)
    .map(([index, part]) => ({ index: Number(index), ...part }))
    .filter((part) => Number.isInteger(part.index) && part.index >= 0)
    .sort((left, right) => left.index - right.index);
}
