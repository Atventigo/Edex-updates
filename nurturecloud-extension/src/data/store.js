// IndexedDB wrapper for the extension data layer (database `fua`, version 1).
// Failure-tolerant: if IndexedDB is unavailable (private mode, blocked), reads
// resolve to []/null and writes resolve without throwing; a console.warn is logged.
const DB_NAME = "fua";
const DB_VERSION = 1;

let dbPromise = null;

// Open (and cache) the database. Resolves to null when IndexedDB is unusable.
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const idb = globalThis.indexedDB;
      if (!idb) throw new Error("indexedDB unavailable");
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("leads", { keyPath: "id" });
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by_contact", "contactId", { unique: false });
        db.createObjectStore("scores", { keyPath: "contactId" });
        db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => fail(resolve, "open failed", req.error);
      req.onblocked = () => fail(resolve, "open blocked", null);
    } catch (err) {
      fail(resolve, "open failed", err);
    }
  });
  return dbPromise;
}

function fail(resolve, what, err) {
  console.warn(`[fua/store] ${what}:`, err?.message ?? err);
  dbPromise = null; // allow a retry on the next call
  resolve(null);
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// Run `fn(store)` inside one transaction; returns fallback on any failure.
async function withStore(name, mode, fn, fallback) {
  try {
    const db = await openDB();
    if (!db) return fallback;
    const tx = db.transaction(name, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await fn(tx.objectStore(name));
    if (mode === "readwrite") await done;
    return result;
  } catch (err) {
    console.warn(`[fua/store] ${name} ${mode} failed:`, err?.message ?? err);
    return fallback;
  }
}

// Batch put: all rows in a single transaction.
function putAll(name, rows) {
  if (!rows?.length) return Promise.resolve();
  return withStore(name, "readwrite", (store) => {
    for (const row of rows) store.put(row);
  }, undefined);
}

export const upsertLeads = (rows) => putAll("leads", rows);
export const upsertMessages = (rows) => putAll("messages", rows);
export const saveScores = (rows) => putAll("scores", rows);

export const getLead = (id) =>
  withStore("leads", "readonly", async (s) => (await wrap(s.get(id))) ?? null, null);

export const getMessages = (contactId) =>
  withStore("messages", "readonly", (s) => wrap(s.index("by_contact").getAll(contactId)), []);

export const allLeads = () => withStore("leads", "readonly", (s) => wrap(s.getAll()), []);

export const getMeta = (key) =>
  withStore("meta", "readonly", async (s) => (await wrap(s.get(key)))?.value ?? null, null);

export const setMeta = (key, val) =>
  withStore("meta", "readwrite", (s) => {
    s.put({ key, value: val });
  }, undefined);

// Delete the whole database. Closes the cached connection first, otherwise the
// delete is blocked and later calls would reuse a dead handle.
export async function clearAll() {
  const db = dbPromise ? await dbPromise : null;
  db?.close();
  dbPromise = null;
  const idb = globalThis.indexedDB;
  if (!idb) return;
  await new Promise((resolve) => {
    const req = idb.deleteDatabase("fua");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
