// The browser's device registration (ADR-0029, P6). The Go core registers the browser as a device
// the first time an account signs in; the registration lives here, in IndexedDB, and not in the
// core's data folder in OPFS, which signing out and "forget this browser" wipe. So the browser stays
// one device per account across sign-ins, and the console can tell which entry of the device list
// is "this browser".
// Registrations are kept per server AND account (the identity provider's subject): several accounts
// taking turns in the same browser each keep their own device instead of registering a new one at
// every switch. Versions up to 1.3 kept one registration per server; it stays in the `legacy` store
// until the account it belongs to takes it over (the core checks the account before using it).
// Used by the core's worker (host functions loadDevice/saveDevice, internal/app/host_web.go) and by
// the console (thisBrowserDevice, forgetThisBrowserDevice). Same origin, same database.

const DB = 'clarae-device';
const VERSION = 2;
/** Registrations by [server, account]. */
const STORE = 'devices';
/** The registrations of versions up to 1.3, by server (whatever their account). */
const LEGACY = 'legacy';

export interface BrowserDevice {
  /** The id the cloud gave the device. */
  deviceId: string;
  /** The cloud user it belongs to. */
  userId: string;
}

interface Row extends BrowserDevice {
  server: string;
  /** The identity provider's subject of the account (storage.ts Account.subject). */
  account: string;
  savedAt: string;
}

interface LegacyRow extends BrowserDevice {
  server: string;
  savedAt?: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction as IDBTransaction;
      if (ev.oldVersion >= 1 && db.objectStoreNames.contains(STORE)) {
        // Version 1 kept one row per server: they move to the legacy store as they are.
        const rows = tx.objectStore(STORE).getAll();
        rows.onsuccess = () => {
          db.deleteObjectStore(STORE);
          db.createObjectStore(STORE, { keyPath: ['server', 'account'] });
          const legacy = db.createObjectStore(LEGACY, { keyPath: 'server' });
          for (const r of rows.result as LegacyRow[]) if (r?.server) legacy.put(r);
        };
        return;
      }
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: ['server', 'account'] });
      if (!db.objectStoreNames.contains(LEGACY))
        db.createObjectStore(LEGACY, { keyPath: 'server' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('the device database is blocked by another tab'));
  });
}

async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const req = body(tx);
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error ?? req?.error ?? new Error('device database error'));
      tx.onabort = () => reject(tx.error ?? new Error('device database transaction aborted'));
    });
  } finally {
    db.close();
  }
}

const available = (): boolean => typeof indexedDB !== 'undefined';

const asDevice = (row: BrowserDevice | undefined): BrowserDevice | null =>
  row?.deviceId && row.userId ? { deviceId: row.deviceId, userId: row.userId } : null;

/** The registration of versions up to 1.3 for a server, or null. */
async function legacyDevice(server: string): Promise<BrowserDevice | null> {
  return asDevice(
    (await run([LEGACY], 'readonly', (tx) => tx.objectStore(LEGACY).get(server))) as
      LegacyRow | undefined,
  );
}

/** The user of the registration versions up to 1.3 kept for a server (storage.ts adoption). */
export async function legacyDeviceUser(server: string = location.origin): Promise<string | null> {
  if (!available()) return null;
  try {
    return (await legacyDevice(server))?.userId ?? null;
  } catch {
    return null;
  }
}

/**
 * The device remembered for an account on a server, or null. Without one of its own, the account
 * is offered the registration of an earlier version: the core uses it only when it belongs to the
 * account that signs in (it compares the user with /me and registers a new device otherwise).
 */
export async function loadDevice(server: string, account: string): Promise<BrowserDevice | null> {
  if (!available() || !account) return null;
  const own = asDevice(
    (await run([STORE], 'readonly', (tx) => tx.objectStore(STORE).get([server, account]))) as
      Row | undefined,
  );
  return own ?? (await legacyDevice(server));
}

/**
 * Remembers the device of an account for a server. The registration of an earlier version that
 * belonged to the same user is now this account's, and goes.
 */
export async function saveDevice(
  server: string,
  deviceId: string,
  userId: string,
  account: string,
): Promise<void> {
  if (!available() || !account) return;
  const row: Row = { server, account, deviceId, userId, savedAt: new Date().toISOString() };
  const legacy = await legacyDevice(server).catch(() => null);
  await run([STORE, LEGACY], 'readwrite', (tx) => {
    if (legacy?.userId === userId) tx.objectStore(LEGACY).delete(server);
    return tx.objectStore(STORE).put(row);
  });
}

/**
 * The id of this browser's device for the signed-in account, or null when this browser has not
 * registered one for it. The console's device list marks that entry as "this browser".
 */
export async function thisBrowserDevice(
  userId: string,
  account: string,
  server: string = location.origin,
): Promise<string | null> {
  try {
    const d = await loadDevice(server, account);
    return d && d.userId === userId ? d.deviceId : null;
  } catch {
    return null; // private mode or blocked storage: nothing is marked
  }
}

/**
 * Forgets this browser's device of an account for a server (and the registration of an earlier
 * version, when it is the same user's): after revoking that device from the console, or when the
 * account is deleted, so the next workbench registers a new one at once (the core also notices a
 * revoked device).
 */
export async function forgetThisBrowserDevice(
  account: string,
  userId?: string,
  server: string = location.origin,
): Promise<void> {
  if (!available()) return;
  try {
    const legacy = userId ? await legacyDevice(server) : null;
    await run([STORE, LEGACY], 'readwrite', (tx) => {
      if (legacy && legacy.userId === userId) tx.objectStore(LEGACY).delete(server);
      return tx.objectStore(STORE).delete([server, account]);
    });
  } catch {
    /* nothing to forget */
  }
}
