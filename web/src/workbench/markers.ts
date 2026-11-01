/**
 * What this browser remembers about the vault copies the workbench keeps in OPFS: one marker per cloud
 * vault (or received share), in localStorage so the console can read it too. The workbench writes it when
 * it opens a vault and keeps it current from the core's sync events; it is removed with the copy.
 *
 * It exists so nothing that was not uploaded yet is deleted silently (D-04): signing out and "forget this
 * browser" ask first when a marker says a copy holds changes, and the start-up sweep that removes the
 * clear text of private vaults left behind by a closed tab (ADR-0029 §6) skips those copies.
 */

export const MARKERS_KEY = 'memobrain.workbench.vaults';

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

export function readMarkers(): Markers {
  const raw = storage()?.getItem(MARKERS_KEY);
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

function writeMarkers(m: Markers): void {
  const s = storage();
  if (!s) return;
  try {
    if (Object.keys(m).length === 0) s.removeItem(MARKERS_KEY);
    else s.setItem(MARKERS_KEY, JSON.stringify(m));
  } catch {
    // quota exceeded or storage blocked: the marker is a safety net, the copy itself is intact
  }
}

/** Creates or updates the marker of a vault; fields not given keep their value (or a clean default). */
export function updateMarker(
  id: string,
  patch: Partial<VaultMarker>,
  now: number = Date.now(),
): VaultMarker {
  const all = readMarkers();
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
  writeMarkers(all);
  return next;
}

export function removeMarker(id: string): void {
  const all = readMarkers();
  if (!(id in all)) return;
  delete all[id];
  writeMarkers(all);
}

export function clearMarkers(): void {
  writeMarkers({});
}

/** True when the copy may hold something the cloud does not have. */
export const unsynced = (m: VaultMarker): boolean => m.pending > 0 || m.conflicts > 0 || m.dirty;

/** The copies that hold changes not uploaded yet, for the confirmations of the console. */
export function unsyncedVaults(): (VaultMarker & { id: string })[] {
  return Object.entries(readMarkers())
    .filter(([, m]) => unsynced(m))
    .map(([id, m]) => ({ id, ...m }));
}

/**
 * The start-up sweep: removes the clear-text copy of every private vault whose marker says it holds
 * nothing that was not uploaded, and its marker. Copies with changes are kept (the caller decides what to
 * show for the one being opened). Resolves to the ids it removed.
 */
export async function sweepPrivateCopies(wipe: (path: string) => Promise<void>): Promise<string[]> {
  const removed: string[] = [];
  for (const [id, m] of Object.entries(readMarkers())) {
    if (m.kind !== 'private' || unsynced(m) || !m.localPath) continue;
    try {
      await wipe(m.localPath);
      removeMarker(id);
      removed.push(id);
    } catch (e) {
      console.warn(`memobrain: could not remove the copy of vault ${id}:`, e);
    }
  }
  return removed;
}
