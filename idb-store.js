/**
 * idb-store.js — Thin IndexedDB wrapper for offline report queue
 * Used by both app.js (main thread) and sw.js (service worker context)
 */

const DB_NAME    = 'civicpulse-db';
const DB_VERSION = 1;
const STORE_NAME = 'pendingReports';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (evt) => {
      const db = evt.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = ()  => resolve(req.result);
    req.onerror   = ()  => reject(req.error);
  });
}

/** Save a pending report to IndexedDB */
export async function saveReport(reportData) {
  const db    = await openDB();
  const tx    = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const id    = await new Promise((resolve, reject) => {
    const req = store.add({ ...reportData, createdAt: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  await tx.complete;
  db.close();
  return id;
}

/** Retrieve all pending reports */
export async function getPendingReports() {
  const db    = await openDB();
  const tx    = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const items = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  db.close();
  return items;
}

/** Delete a report by its auto-generated id */
export async function deleteReport(id) {
  const db    = await openDB();
  const tx    = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  await new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  db.close();
}

/** Count pending reports */
export async function countPendingReports() {
  const db    = await openDB();
  const tx    = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const count = await new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  db.close();
  return count;
}
