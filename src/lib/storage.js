const DB_NAME = 'audio-cutter-db';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const store = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
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

export async function listProjects() {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const records = await promisifyRequest(store.getAll());
    return records
      .map((record) => ({
        id: record.id,
        name: record.name,
        audioName: record.audioName,
        duration: record.duration,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        size: record.audioBlob?.size ?? 0,
        cutsCount: Array.isArray(record.customCuts) ? record.customCuts.length : 0,
        bookmarksCount: Array.isArray(record.bookmarks) ? record.bookmarks.length : 0,
      }))
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  } finally {
    db.close();
  }
}

export async function saveProject(project) {
  const db = await openDatabase();
  try {
    const now = Date.now();
    const record = {
      ...project,
      id: project.id ?? generateId(),
      createdAt: project.createdAt ?? now,
      updatedAt: now,
    };
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    await promisifyRequest(store.put(record));
    return record;
  } finally {
    db.close();
  }
}

export async function loadProject(id) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const record = await promisifyRequest(store.get(id));
    return record ?? null;
  } finally {
    db.close();
  }
}

export async function deleteProject(id) {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    await promisifyRequest(store.delete(id));
  } finally {
    db.close();
  }
}

export async function countProjects() {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    return promisifyRequest(store.count());
  } finally {
    db.close();
  }
}
