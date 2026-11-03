/**
 * What this browser remembers about the vault copies the workbench keeps in OPFS: one marker per cloud
 * vault (or received share), in localStorage so the console can read it too. The workbench writes it when
 * it opens a vault and keeps it current from the core's sync events; it is removed with the copy. Each
 * account has its own set (markersKey), like its own folders (storage.ts): an account never sees or
 * acts on another account's markers.
 *
 * It exists so nothing that was not uploaded yet is deleted silently (D-04): signing out and "forget this
 * browser" ask first when a marker says a copy holds changes, and the start-up sweep that removes the
 * clear text of private vaults left behind by a closed tab (ADR-0029 §6) skips those copies.
 */

/**
 * The localStorage key of the markers of versions up to 1.3, which had no account (storage.ts): read
 * only to adopt or delete the copies they describe.
 */
export const MARKERS_KEY = 'memobrain.workbench.vaults';

/** The localStorage key of an account's markers (`account` is storage.ts accountKey). */
export const markersKey = (account: string): string => `${MARKERS_KEY}@${account}`;

export interface VaultMarker {
  /** Display name, for the confirmation lists. */
  name: string;
  /** "private", "shared", or "" for a folder that is not linked to the cloud. */
  kind: string;
  /** The copy's folder in the core's file system (what `core.wipe` removes). */
  localPath: string;
  /** Changes not uploaded yet, as the core last reported them. */
  pending: number;
  /** Conflicts not resolved yet (their local side may exist only here). */
  conflicts: number;
  /**
   * Set when a file of the copy changed after the last completed sync started: the core counts a change
   * as pending only once a sync scanned it, so a tab closed right after an edit would otherwise look clean.
   */
  dirty: boolean;
  /**
   * Set when the cloud vault was deleted elsewhere (the core's `vault:cloud-deleted`): the copy is no
   * longer linked, so what it holds cannot be uploaded, and the workbench of that vault no longer
   * opens. Cleared when a restored vault is opened again.
   */
  cloudDeleted?: boolean;
  /** Epoch milliseconds of the last update. */
  updatedAt: number;
}

export type Markers = Record<string, VaultMarker>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked by the browser
  }
}

function read(key: string): Markers {
  const raw = storage()?.getItem(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Markers)
      : {};
  } catch {
    return {};
  }
}

function write(key: string, m: Markers): void {
  const s = storage();
  if (!s) return;
  try {
    if (Object.keys(m).length === 0) s.removeItem(key);
    else s.setItem(key, JSON.stringify(m));
  } catch {
    // quota exceeded or storage blocked: the marker is a safety net, the copy itself is intact
  }
}

/** The markers of an account. */
export function readMarkers(account: string): Markers {
  return read(markersKey(account));
}

/** Creates or updates the marker of a vault; fields not given keep their value (or a clean default). */
export function updateMarker(
  account: string,
  id: string,
  patch: Partial<VaultMarker>,
  now: number = Date.now(),
): VaultMarker {
  const all = readMarkers(account);
  const prev = all[id];
  const next: VaultMarker = {
    name: '',
    kind: '',
    localPath: '',
    pending: 0,
    conflicts: 0,
    dirty: false,
    ...prev,
    ...patch,
    updatedAt: now,
  };
  all[id] = next;
  write(markersKey(account), all);
  return next;
}

export function removeMarker(account: string, id: string): void {
  const all = readMarkers(account);
  if (!(id in all)) return;
  delete all[id];
  write(markersKey(account), all);
}

export function clearMarkers(account: string): void {
  write(markersKey(account), {});
}

/** The markers of versions up to 1.3 (no account). */
export function readLegacyMarkers(): Markers {
  return read(MARKERS_KEY);
}

export function clearLegacyMarkers(): void {
  write(MARKERS_KEY, {});
}

/** The account adopted the copies of an earlier version (storage.ts): their markers become its own. */
export function adoptLegacyMarkers(account: string): void {
  const legacy = readLegacyMarkers();
  if (Object.keys(legacy).length > 0)
    write(markersKey(account), { ...legacy, ...readMarkers(account) });
  clearLegacyMarkers();
}

/** True when the copy may hold something the cloud does not have. */
export const unsynced = (m: VaultMarker): boolean => m.pending > 0 || m.conflicts > 0 || m.dirty;

/** The copies of an account that hold changes not uploaded yet, for the confirmations of the console. */
export function unsyncedVaults(account: string): (VaultMarker & { id: string })[] {
  return Object.entries(readMarkers(account))
    .filter(([, m]) => unsynced(m))
    .map(([id, m]) => ({ id, ...m }));
}

/**
 * The start-up sweep: removes the clear-text copy of every private vault of the account whose marker
 * says it holds nothing that was not uploaded, and its marker. Copies with changes are kept (the caller
 * decides what to show for the one being opened). Resolves to the ids it removed.
 */
export async function sweepPrivateCopies(
  account: string,
  wipe: (path: string) => Promise<void>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const [id, m] of Object.entries(readMarkers(account))) {
    if (m.kind !== 'private' || unsynced(m) || !m.localPath) continue;
    try {
      await wipe(m.localPath);
      removeMarker(account, id);
      removed.push(id);
    } catch (e) {
      console.warn(`memobrain: could not remove the copy of vault ${id}:`, e);
    }
  }
  return removed;
}
