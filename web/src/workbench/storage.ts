/**
 * Where the vault workbench keeps an account's data in this browser, and what happens to the copies
 * an earlier version left behind.
 *
 * A browser profile may be used by more than one account (a shared computer). Each account has
 * folders of its own in the Origin Private File System, named by a key derived from the server and
 * the account's subject (accountKey):
 *
 *   accounts/<key>/fs       the core's file system: vault copies, mounts, the core's data folder
 *   accounts/<key>/sqlite   the SQLite pool (indexes, sync state)
 *
 * and its own markers in localStorage (markers.ts) and device registration in IndexedDB (device.ts).
 * The workbench of one account never opens, lists or removes another account's folders: signing
 * out and "forget this browser" act on the signed-in account only, and another account's copies
 * stay until that account signs out or forgets the browser (or the browser's site data is cleared).
 *
 * Up to 1.4 the key was derived with another salt (the product's former name, legacyNames.ts), and
 * so were the data folder inside the account's file system and the markers. A profile used with 1.4
 * is taken to the new names before the core starts (migrateAccountStorage, migrateDataFolder), under
 * the workbench Web Locks; what cannot be moved is read under the old name (markers) or removed
 * together with the new (sign-out, "forget this browser").
 *
 * Versions up to 1.3 kept a single, unnamed set (`fs`, `memobrain-sqlite`, the markers key without
 * an account). It is adopted by an account only when the account can be shown to own every copy in
 * it (ownsLegacy): the core's session in it names the same server and user, the device the browser
 * registered (if any) belongs to that user, and every vault and mount in it is one the account can
 * reach in the cloud. The adoption is a record (LEGACY_OWNER_FILE), not a move: the folders stay where
 * they are and become that account's storage. A set nobody can be shown to own is never opened; the
 * console offers to delete it (Account page).
 */
import { LEGACY_ACCOUNT_SALT, LEGACY_DATA_ROOT } from './legacyNames';
import {
  adoptLegacyMarkers,
  clearLegacyMarkers,
  clearMarkers,
  readLegacyMarkers,
  type Markers,
} from './markers';
import { childDir, dropMoveMarkers, moveFolder, type Dir, type MoveOutcome } from './migrate';

/** The account a workbench works for: the cloud (origin) and the identity provider's subject. */
export interface Account {
  server: string;
  subject: string;
}

/** The subject used by a page without a cloud (`?local`, E2E builds only) and nobody signed in. */
export const LOCAL_SUBJECT = 'local';

/**
 * The key of an account's storage: a hash, so folder and storage names carry neither the subject
 * nor characters a file name cannot hold. 128 bits of SHA-256 (no collision between accounts).
 */
export async function accountKey(a: Account): Promise<string> {
  return deriveKey('clarae/workbench-account', a);
}

/** The key of the same account up to 1.4: the name of what a profile used with 1.4 holds. */
export async function legacyAccountKey(a: Account): Promise<string> {
  return deriveKey(LEGACY_ACCOUNT_SALT, a);
}

/** Both keys of an account: callers that remove or read what the account holds need both. */
export async function accountKeys(a: Account): Promise<{ key: string; legacyKey: string }> {
  const [key, legacyKey] = await Promise.all([accountKey(a), legacyAccountKey(a)]);
  return { key, legacyKey };
}

async function deriveKey(salt: string, a: Account): Promise<string> {
  const data = new TextEncoder().encode(`${salt}\n${a.server}\n${a.subject}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return 'a' + Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const ACCOUNTS_DIR = 'accounts';
/** The unnamed set of versions up to 1.3. */
export const LEGACY_FS = 'fs';
export const LEGACY_SQLITE = 'memobrain-sqlite';
/** At the OPFS root: the account that adopted the unnamed set (`{"account": key}`). */
export const LEGACY_OWNER_FILE = 'legacy-owner.json';

/** The folders of an account's storage, as the worker opens them. */
export interface AccountStorage {
  /** The core's file system (an OPFS folder path, see opfs-fs.ts `rootName`). */
  fs: string;
  /** The directory of the SQLite pool (sqlite-wasm's opfs-sahpool `directory`). */
  sqlite: string;
  /** True for the unnamed set an account adopted. */
  legacy: boolean;
}

export function namespacedStorage(key: string): AccountStorage {
  return {
    fs: `${ACCOUNTS_DIR}/${key}/fs`,
    sqlite: `/${ACCOUNTS_DIR}/${key}/sqlite`,
    legacy: false,
  };
}

export const LEGACY_STORAGE: AccountStorage = {
  fs: LEGACY_FS,
  sqlite: `/${LEGACY_SQLITE}`,
  legacy: true,
};

// ---- OPFS ---------------------------------------------------------------------------------------

/** The OPFS root, or null where there is none (old browser, jsdom, an insecure origin). */
export async function opfsRoot(): Promise<Dir | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  return navigator.storage.getDirectory();
}

const notFound = (e: unknown): boolean => (e as { name?: string }).name === 'NotFoundError';
const typeMismatch = (e: unknown): boolean => (e as { name?: string }).name === 'TypeMismatchError';

async function dirAt(root: Dir, path: string[]): Promise<Dir | null> {
  let d = root;
  for (const name of path) {
    try {
      d = await d.getDirectoryHandle(name);
    } catch (e) {
      if (notFound(e) || typeMismatch(e)) return null;
      throw e;
    }
  }
  return d;
}

async function subdirs(root: Dir, path: string[]): Promise<string[]> {
  const d = await dirAt(root, path);
  if (!d) return [];
  const out: string[] = [];
  for await (const [name, h] of d.entries()) if (h.kind === 'directory') out.push(name);
  return out.sort();
}

async function readJSON(root: Dir, path: string[]): Promise<unknown> {
  const d = await dirAt(root, path.slice(0, -1));
  if (!d) return null;
  try {
    const f = await d.getFileHandle(path[path.length - 1] as string);
    return JSON.parse(await (await f.getFile()).text()) as unknown;
  } catch {
    return null; // missing or not JSON: no evidence
  }
}

/** The account that adopted the unnamed set, or null. */
export async function readLegacyOwner(root?: Dir | null): Promise<string | null> {
  const r = root === undefined ? await opfsRoot() : root;
  if (!r) return null;
  const v = (await readJSON(r, [LEGACY_OWNER_FILE])) as { account?: unknown } | null;
  return typeof v?.account === 'string' && v.account !== '' ? v.account : null;
}

async function writeLegacyOwner(root: Dir, key: string): Promise<void> {
  const f = await root.getFileHandle(LEGACY_OWNER_FILE, { create: true });
  const w = await (
    f as unknown as {
      createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
    }
  ).createWritable();
  await w.write(JSON.stringify({ account: key, adoptedAt: new Date().toISOString() }));
  await w.close();
}

/** Whether the unnamed set of an earlier version is here (whoever owns it). */
async function legacyPresent(root: Dir): Promise<boolean> {
  return (await dirAt(root, [LEGACY_FS])) !== null || (await dirAt(root, [LEGACY_SQLITE])) !== null;
}

/** The storage of an account: the unnamed set when it adopted it, its own folders otherwise. */
export async function storageOf(key: string): Promise<AccountStorage> {
  return (await readLegacyOwner()) === key ? LEGACY_STORAGE : namespacedStorage(key);
}

// ---- taking a profile of 1.4 to the names of 2.0 -------------------------------------------------

/** The core's data folder inside the core's file system, as the core is told (launch.ts). */
export const DATA_ROOT = 'clarae';
export const DATA_DIR = `/${DATA_ROOT}/data`;

/**
 * Takes the storage a profile used with 1.4 holds under the account's old key to the new key:
 * the record of an adopted unnamed set (it names its account), and the account's folder
 * (`accounts/<old>` to `accounts/<new>`, SQLite pool included, as it is: the databases inside keep
 * the names the core gave them). Resumable and safe to repeat (migrate.ts moveFolder); an account
 * that already has storage under the new key keeps it and the old folder stays where it is.
 * Runs on the workbench page, under the locks, before the core starts.
 */
export async function migrateAccountStorage(key: string, legacyKey: string): Promise<MoveOutcome> {
  const root = await opfsRoot();
  if (!root || key === legacyKey) return 'none';
  if ((await readLegacyOwner(root)) === legacyKey) await writeLegacyOwner(root, key);
  const accounts = await childDir(root, ACCOUNTS_DIR);
  if (!accounts) return 'none';
  return moveFolder(accounts, legacyKey, accounts, key);
}

/**
 * Takes the core's data folder of the storage `s` from its name up to 1.4 to the current one
 * (`LEGACY_DATA_ROOT/data` to `DATA_ROOT/data` inside the storage's `fs`): the session, the mounts and the other state the
 * core keeps outside the vaults. Same guarantees as migrateAccountStorage; call it after the
 * account's folder and the adoption of an unnamed set are settled.
 */
export async function migrateDataFolder(s: AccountStorage): Promise<MoveOutcome> {
  const root = await opfsRoot();
  if (!root) return 'none';
  const fs = await dirAt(root, s.fs.split('/'));
  if (!fs) return 'none';
  const oldRoot = await childDir(fs, LEGACY_DATA_ROOT);
  const newRoot = await childDir(fs, DATA_ROOT);
  if (!oldRoot) {
    if (newRoot) await dropMoveMarkers(newRoot, 'data');
    return 'none';
  }
  const target = newRoot ?? (await fs.getDirectoryHandle(DATA_ROOT, { create: true }));
  const outcome = await moveFolder(oldRoot, 'data', target, 'data');
  // The folder of the old name goes once it is empty (removing one that is not fails: it stays).
  if (outcome !== 'kept') await fs.removeEntry(LEGACY_DATA_ROOT).catch(() => undefined);
  return outcome;
}

// ---- adopting the unnamed set ---------------------------------------------------------------------

/** What the unnamed set says about its owner. */
export interface LegacyEvidence {
  /** The core's session file (`fs/memobrain/data/auth.json`), or null. */
  session: { server_url?: unknown; profile?: { userId?: unknown } } | null;
  /** Folders of vault copies (`fs/vaults/<name>`). */
  vaultFolders: string[];
  /** Folders of mounts (`fs/memobrain/data/mounts/<share id>`). */
  mountFolders: string[];
  /** The markers of the unnamed set. */
  markers: Markers;
  /** The user of the device the browser registered for the server before, or null. */
  deviceUserId: string | null;
}

/** What the cloud says the signed-in account can reach. */
export interface CloudView {
  /** The cloud user id (/me). */
  userId: string;
  /** Its vaults, deleted ones included (/vaults?include_deleted=true). */
  vaultIds: ReadonlySet<string>;
  /** The shares it received, whatever their state (/shares?scope=received). */
  shareIds: ReadonlySet<string>;
}

/**
 * Whether the account of `cloud` owns everything in the unnamed set: nothing in it may belong to
 * someone else. Unknown counts as someone else's (a folder no marker explains, a missing session).
 */
export function ownsLegacy(e: LegacyEvidence, server: string, cloud: CloudView): boolean {
  if (!e.session || e.session.server_url !== server) return false;
  if (e.session.profile?.userId !== cloud.userId) return false;
  if (e.deviceUserId !== null && e.deviceUserId !== cloud.userId) return false;
  const byPath = new Map(Object.entries(e.markers).map(([id, m]) => [m.localPath, id]));
  for (const folder of e.vaultFolders) {
    let cloudId = folder;
    if (folder.startsWith('new-')) {
      // Created in the browser (create.ts): the marker says which cloud vault it became.
      const id = byPath.get(`/vaults/${folder}`);
      if (id === undefined) return false;
      if (id.startsWith('new-')) continue; // the creation never reached the cloud: an empty folder
      cloudId = id;
    }
    if (!cloud.vaultIds.has(cloudId)) return false;
  }
  return e.mountFolders.every((share) => cloud.shareIds.has(share));
}

async function readLegacyEvidence(root: Dir, deviceUserId: string | null): Promise<LegacyEvidence> {
  const session = (await readJSON(root, [LEGACY_FS, 'memobrain', 'data', 'auth.json'])) as
    LegacyEvidence['session'] | null;
  return {
    session: session && typeof session === 'object' ? session : null,
    vaultFolders: await subdirs(root, [LEGACY_FS, 'vaults']),
    mountFolders: await subdirs(root, [LEGACY_FS, 'memobrain', 'data', 'mounts']),
    markers: readLegacyMarkers(),
    deviceUserId,
  };
}

export type Adoption =
  /** Nothing of an earlier version here. */
  | 'none'
  /** This account adopted the set (now or before). */
  | 'owned'
  /** Adopted by another account: never touched here. */
  | 'other'
  /** The account already had storage of its own: the set is not merged into it. */
  | 'kept'
  /** Not shown to belong to this account: left alone, unopened. */
  | 'unproven';

export interface AdoptOptions {
  key: string;
  server: string;
  /** The user of the device registered before for the server (device.ts legacyDeviceUser). */
  deviceUserId: () => Promise<string | null>;
  /**
   * What the cloud says the account can reach; asked only when there is something to prove. Its
   * failure (no network) fails the adoption, which is tried again at the next start.
   */
  cloud: (need: { vaults: boolean; shares: boolean }) => Promise<CloudView>;
}

/**
 * Adopts the unnamed set of an earlier version for the account `key` when it owns everything in it
 * (see the module comment). Runs in the workbench page before the core starts, so nothing holds
 * the files. Never removes anything but the markers of a set that has no folders left.
 */
export async function adoptLegacyCopies(o: AdoptOptions): Promise<Adoption> {
  const root = await opfsRoot();
  if (!root) return 'none';
  const owner = await readLegacyOwner(root);
  if (owner) return owner === o.key ? 'owned' : 'other';
  if (!(await legacyPresent(root))) {
    clearLegacyMarkers(); // they describe copies that are gone
    return 'none';
  }
  // Two sets cannot be merged: an account that already has its own keeps it.
  if ((await dirAt(root, [ACCOUNTS_DIR, o.key])) !== null) return 'kept';
  const evidence = await readLegacyEvidence(root, await o.deviceUserId());
  if (!evidence.session) return 'unproven';
  const cloud = await o.cloud({
    vaults: evidence.vaultFolders.length > 0,
    shares: evidence.mountFolders.length > 0,
  });
  if (!ownsLegacy(evidence, o.server, cloud)) return 'unproven';
  await writeLegacyOwner(root, o.key);
  adoptLegacyMarkers(o.key);
  return 'owned';
}

/** For the console: whether an unnamed set nobody adopted is here (it can only be deleted). */
export async function unownedLegacyPresent(): Promise<boolean> {
  const root = await opfsRoot();
  if (!root) return false;
  return (await readLegacyOwner(root)) === null && (await legacyPresent(root));
}

// ---- removing ---------------------------------------------------------------------------------------

export interface RemoveResult {
  /** True when there was nothing to remove or it was all removed. */
  removed: boolean;
  /** True when a workbench open in another tab holds the files. */
  busy: boolean;
}

async function removeAll(root: Dir, paths: string[][]): Promise<RemoveResult> {
  let busy = false;
  for (const path of paths) {
    const parent = await dirAt(root, path.slice(0, -1));
    if (!parent) continue;
    try {
      await parent.removeEntry(path[path.length - 1] as string, { recursive: true });
    } catch (e) {
      const err = (e as { name?: string }).name;
      if (err === 'NotFoundError') continue;
      if (err === 'NoModificationAllowedError' || err === 'InvalidStateError') busy = true;
      else throw e;
    }
  }
  return { removed: !busy, busy };
}

/**
 * Removes the storage of the account `key` (its folders, or the unnamed set it adopted) and its
 * markers, and what a profile of 1.4 still holds for it under `legacyKey` (the key it had then):
 * signing out must not leave a clear-text copy behind under the old name. Other accounts' storage
 * is left as it is.
 */
export async function removeAccountStorage(key: string, legacyKey?: string): Promise<RemoveResult> {
  const root = await opfsRoot();
  if (!root) {
    clearMarkers(key, legacyKey);
    return { removed: true, busy: false };
  }
  const owner = await readLegacyOwner(root);
  const adopted = owner !== null && (owner === key || owner === legacyKey);
  const r = await removeAll(root, [
    [ACCOUNTS_DIR, key],
    ...(legacyKey && legacyKey !== key ? [[ACCOUNTS_DIR, legacyKey]] : []),
    ...(adopted ? [[LEGACY_FS], [LEGACY_SQLITE]] : []),
  ]);
  if (r.busy) return r;
  if (adopted) await removeAll(root, [[LEGACY_OWNER_FILE]]);
  const accounts = await childDir(root, ACCOUNTS_DIR);
  if (accounts) {
    // The markers of an interrupted migration to this account's key go with it.
    await dropMoveMarkers(accounts, key);
    // The parent of the accounts' folders goes when it is empty (removing a folder that is not fails).
    await root.removeEntry(ACCOUNTS_DIR).catch(() => undefined);
  }
  clearMarkers(key, legacyKey);
  return r;
}

/** Removes the unnamed set of an earlier version that no account adopted (the console asks first). */
export async function removeUnownedLegacy(): Promise<RemoveResult> {
  const root = await opfsRoot();
  if (!root) {
    clearLegacyMarkers();
    return { removed: true, busy: false };
  }
  if ((await readLegacyOwner(root)) !== null) return { removed: true, busy: false };
  const r = await removeAll(root, [[LEGACY_FS], [LEGACY_SQLITE]]);
  if (!r.busy) clearLegacyMarkers();
  return r;
}
