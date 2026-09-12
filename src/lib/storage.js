const DB_NAME = 'audio-cutter-db';
// v2: i metadati vivono in STORE_META (lettura leggera per la lista),
// i blob audio in STORE_AUDIO (letti solo on-demand all'apertura).
// Lo store v1 STORE_PROJECTS_LEGACY viene migrato e svuotato al primo accesso.
const DB_VERSION = 2;
const STORE_PROJECTS_LEGACY = 'projects';
const STORE_META = 'projectMeta';
const STORE_AUDIO = 'projectAudio';

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

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB non è supportato in questo browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS_LEGACY)) {
        const store = db.createObjectStore(STORE_PROJECTS_LEGACY, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        const meta = db.createObjectStore(STORE_META, { keyPath: 'id' });
        meta.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toMetaView(meta) {
  return {
    id: meta.id,
    name: meta.name,
    audioName: meta.audioName,
    duration: meta.duration,
    updatedAt: meta.updatedAt,
    createdAt: meta.createdAt,
    size: meta.size ?? 0,
    cutsCount: typeof meta.cutsCount === 'number'
      ? meta.cutsCount
      : Array.isArray(meta.customCuts) ? meta.customCuts.length : 0,
    bookmarksCount: typeof meta.bookmarksCount === 'number'
      ? meta.bookmarksCount
      : Array.isArray(meta.bookmarks) ? meta.bookmarks.length : 0,
  };
}

// Migra una tantum i record v1 (meta+blob insieme) nei due store v2.
// Usa count() (economico) come gate: dopo la migrazione lo store legacy è vuoto.
async function migrateLegacyIfNeeded(db) {
  if (!db.objectStoreNames.contains(STORE_PROJECTS_LEGACY)) {
    return;
  }
  const countTx = db.transaction(STORE_PROJECTS_LEGACY, 'readonly');
  const legacyCount = await promisifyRequest(countTx.objectStore(STORE_PROJECTS_LEGACY).count());
  if (!legacyCount) {
    return;
  }
  const readTx = db.transaction(STORE_PROJECTS_LEGACY, 'readonly');
  const records = await promisifyRequest(readTx.objectStore(STORE_PROJECTS_LEGACY).getAll());
  if (!records || records.length === 0) {
    return;
  }
  const writeTx = db.transaction([STORE_META, STORE_AUDIO, STORE_PROJECTS_LEGACY], 'readwrite');
  const metaStore = writeTx.objectStore(STORE_META);
  const audioStore = writeTx.objectStore(STORE_AUDIO);
  const legacyStore = writeTx.objectStore(STORE_PROJECTS_LEGACY);
  for (const record of records) {
    const { audioBlob, ...rest } = record;
    const meta = {
      ...rest,
      size: audioBlob?.size ?? rest.size ?? 0,
      cutsCount: Array.isArray(rest.customCuts) ? rest.customCuts.length : 0,
      bookmarksCount: Array.isArray(rest.bookmarks) ? rest.bookmarks.length : 0,
    };
    delete meta.audioBlob;
    metaStore.put(meta);
    if (audioBlob) {
      audioStore.put({ id: record.id, blob: audioBlob });
    }
    legacyStore.delete(record.id);
  }
  await waitForTransaction(writeTx);
}

export async function listProjects() {
  const db = await openDatabase();
  try {
    await migrateLegacyIfNeeded(db);
    // Solo metadati: nessun blob audio attraversa mai questa lettura.
    const tx = db.transaction(STORE_META, 'readonly');
    const metas = await promisifyRequest(tx.objectStore(STORE_META).getAll());
    return metas
      .map(toMetaView)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  } finally {
    db.close();
  }
}

export async function saveProject(project) {
  const db = await openDatabase();
  try {
    const now = Date.now();
    const id = project.id ?? generateId();
    const { audioBlob, ...rest } = project;
    const meta = {
      ...rest,
      id,
      createdAt: project.createdAt ?? now,
      updatedAt: now,
      size: audioBlob?.size ?? rest.size ?? 0,
      cutsCount: Array.isArray(rest.customCuts) ? rest.customCuts.length : 0,
      bookmarksCount: Array.isArray(rest.bookmarks) ? rest.bookmarks.length : 0,
    };
    const tx = db.transaction([STORE_META, STORE_AUDIO], 'readwrite');
    tx.objectStore(STORE_META).put(meta);
    if (audioBlob) {
      tx.objectStore(STORE_AUDIO).put({ id, blob: audioBlob });
    } else if (project.id) {
      // Aggiornamento metadati senza nuovo audio: conserva il blob esistente.
    }
    await waitForTransaction(tx);
    return { ...meta, ...(audioBlob ? { audioBlob } : {}) };
  } finally {
    db.close();
  }
}

export async function loadProject(id) {
  const db = await openDatabase();
  try {
    await migrateLegacyIfNeeded(db);
    const tx = db.transaction([STORE_META, STORE_AUDIO, STORE_PROJECTS_LEGACY], 'readonly');
    const stores = tx.objectStoreNames;
    let meta = stores.contains(STORE_META)
      ? await promisifyRequest(tx.objectStore(STORE_META).get(id))
      : null;
    let audioBlob = null;
    if (meta && stores.contains(STORE_AUDIO)) {
      const audioRec = await promisifyRequest(tx.objectStore(STORE_AUDIO).get(id));
      audioBlob = audioRec?.blob ?? null;
    }
    if (!meta && stores.contains(STORE_PROJECTS_LEGACY)) {
      const legacy = await promisifyRequest(tx.objectStore(STORE_PROJECTS_LEGACY).get(id));
      if (legacy) {
        return legacy;
      }
    }
    if (!meta) {
      return null;
    }
    return { ...meta, audioBlob };
  } finally {
    db.close();
  }
}

export async function deleteProject(id) {
  const db = await openDatabase();
  try {
    const stores = [STORE_META, STORE_AUDIO];
    if (db.objectStoreNames.contains(STORE_PROJECTS_LEGACY)) {
      stores.push(STORE_PROJECTS_LEGACY);
    }
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) {
      tx.objectStore(name).delete(id);
    }
    await waitForTransaction(tx);
  } finally {
    db.close();
  }
}

export async function countProjects() {
  const db = await openDatabase();
  try {
    let total = 0;
    if (db.objectStoreNames.contains(STORE_META)) {
      const tx = db.transaction(STORE_META, 'readonly');
      total += await promisifyRequest(tx.objectStore(STORE_META).count());
    }
    if (db.objectStoreNames.contains(STORE_PROJECTS_LEGACY)) {
      const txLegacy = db.transaction(STORE_PROJECTS_LEGACY, 'readonly');
      total += await promisifyRequest(txLegacy.objectStore(STORE_PROJECTS_LEGACY).count());
    }
    return total;
  } finally {
    db.close();
  }
}
