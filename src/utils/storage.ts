const DB_NAME = "veritashe_idb";
const STORE_NAME = "workspace";
const WORKSPACE_KEY = "active_state_v3";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let writeInFlight = false;
let pendingWriteData: unknown = null;
let hasPendingWrite = false;

export async function saveWorkspaceToDB<T>(data: T): Promise<void> {
  pendingWriteData = data;
  hasPendingWrite = true;
  if (writeInFlight) return;

  writeInFlight = true;
  try {
    const db = await openDB();
    while (hasPendingWrite) {
      const nextData = pendingWriteData;
      pendingWriteData = null;
      hasPendingWrite = false;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(nextData, WORKSPACE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => resolve();
      });
    }
  } catch {
    // Ignore storage failures in restricted contexts
  } finally {
    writeInFlight = false;
    pendingWriteData = null;
    hasPendingWrite = false;
  }
}

export async function loadWorkspaceFromDB<T>(): Promise<T | null> {
  try {
    const db = await openDB();
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(WORKSPACE_KEY);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearWorkspaceFromDB(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(WORKSPACE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}
