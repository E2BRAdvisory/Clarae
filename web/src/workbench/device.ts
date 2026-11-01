// The browser's device registration (ADR-0029, P6). The Go core registers the browser as a device
// the first time it signs in; the registration lives here, in IndexedDB, and not in the core's data
// folder in OPFS, which signing out and "forget this browser" wipe. So the browser stays one device
// across sign-ins, and the console can tell which entry of the device list is "this browser".
// Used by the core's worker (host functions loadDevice/saveDevice, internal/app/host_web.go) and by
// the console (thisBrowserDevice, forgetThisBrowserDevice). Same origin, same database.

const DB = 'memobrain-device';
const STORE = 'devices';

export interface BrowserDevice {
  /** The id the cloud gave the device. */
  deviceId: string;
  /** The account it belongs to: another account in the same browser registers its own. */
  userId: string;
}

interface Row extends BrowserDevice {
  server: string;
  savedAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: 'server' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('the device database is blocked by another tab'));
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = body(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('device database error'));
      tx.onabort = () => reject(tx.error ?? new Error('device database transaction aborted'));
    });
  } finally {
    db.close();
  }
}

const available = (): boolean => typeof indexedDB !== 'undefined';

/** The device remembered for a server (default: this origin), or null. */
export async function loadDevice(server: string = location.origin): Promise<BrowserDevice | null> {
  if (!available()) return null;
  const row = (await run('readonly', (s) => s.get(server))) as Row | undefined;
  return row?.deviceId && row.userId ? { deviceId: row.deviceId, userId: row.userId } : null;
}

/** Remembers the device of an account for a server. */
export async function saveDevice(server: string, deviceId: string, userId: string): Promise<void> {
  if (!available()) return;
  const row: Row = { server, deviceId, userId, savedAt: new Date().toISOString() };
  await run('readwrite', (s) => s.put(row));
}

/**
 * The id of this browser's device for the signed-in account, or null when this browser has not
 * registered one for it. The console's device list marks that entry as "this browser".
 */
export async function thisBrowserDevice(
  userId: string,
  server: string = location.origin,
): Promise<string | null> {
  try {
    const d = await loadDevice(server);
    return d && d.userId === userId ? d.deviceId : null;
  } catch {
    return null; // private mode or blocked storage: nothing is marked
  }
}

/**
 * Forgets this browser's device for a server: call it after revoking that device from the console,
 * so the next workbench registers a new one at once (the core also notices a revoked device).
 */
export async function forgetThisBrowserDevice(server: string = location.origin): Promise<void> {
  if (!available()) return;
  try {
    await run('readwrite', (s) => s.delete(server));
  } catch {
    /* nothing to forget */
  }
}
