/**
 * Keeps watch over the vault open in the workbench page:
 * - its marker (markers.ts) follows the core's sync events, so the console and the next start-up know
 *   whether the copy in this browser holds changes the cloud does not have;
 * - for a private vault, a lock (manual or the core's idle timer, ADR-0029 §6) removes the clear-text copy
 *   from the browser and goes back to the console, unless that would lose changes (D-04): then a blocking
 *   overlay says what is kept and lets the user unlock, delete anyway or leave the copy for later;
 * - leaving (back to the console, signing out, a request from the console) uploads what it can first.
 */
import type { CoreHandle } from './bridge';
import { readMarkers, removeMarker, unsynced, updateMarker, type VaultMarker } from './markers';
import { closeOverlay, confirmDelete, showLocked, showOverlay, unsyncedLines } from './overlay';
import { message } from './strings';

/**
 * Payload of the core's `vault:locked` event (sync.LockedEvent; older cores send only `vaultId`). It is
 * emitted once the key left memory; `pending` is -1 when the core could not count the changes. Reason
 * "sync" is not a lock: the sync loop repeats it while the vault waits for its passphrase.
 */
export interface VaultLockedPayload {
  vaultId: string;
  reason?: 'manual' | 'idle' | 'sync';
  pending?: number;
  conflicts?: number;
}

interface SyncStatus {
  vaultId: string;
  phase: string;
  pending: number;
  conflicts: number;
}

export interface GuardOptions {
  core: CoreHandle;
  /** The signed-in account's key (storage.ts): whose marker follows the vault. */
  account: string;
  /** The marker's key: the cloud vault id (or `share:<id>` for a received share). */
  markerId: string;
  info: { id: string; name: string; path: string };
  /** "private" or "shared". */
  kind: string;
  /** Writes the workbench's pending edits (bounded, never rejects). */
  flush: () => Promise<void>;
  goToConsole: () => void;
  /** Reloads the page (unlocking a locked copy goes through the start-up gate, see launch.ts). */
  reload: () => void;
  now?: () => number;
  /** How long leaving waits for the outbox to drain before locking (default 15 s). */
  drainMs?: number;
  pollMs?: number;
}

export interface VaultGuard {
  /** The vault was unlocked in this page: a later `vault:locked` is a real lock. */
  noteUnlocked(): void;
  /** Leaves for the console: uploads, then for a private vault locks and removes the copy. */
  leave(): Promise<void>;
  /** Flushes, uploads (bounded), locks and removes the copy, or keeps it and says why. */
  lockAndForget(): Promise<void>;
  /** Removes the copy and its marker whatever it holds (the user confirmed), then leaves. */
  deleteCopy(): Promise<void>;
  /**
   * "Remove from this browser" (the web's counterpart of the desktop's Disconnect): uploads what is
   * pending (bounded), then removes the copy and goes back to the console; when changes would be
   * lost it keeps the copy and asks. A private vault is locked first (lockAndForget).
   */
  removeCopy(): Promise<void>;
  dispose(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createVaultGuard(o: GuardOptions): VaultGuard {
  const { core, info } = o;
  const now = o.now ?? Date.now;
  const isPrivate = o.kind === 'private';
  let unlocked = false;
  let selfLock = false;
  let lockPayload: VaultLockedPayload | null = null;
  let running: Promise<void> | null = null;
  let deciding = false;

  // A change the core may not have scanned yet: cleared by a sync that started after it and ended clean.
  let dirtyAt = readMarkers(o.account)[o.markerId]?.dirty ? now() : 0;
  let runStartedAt = 0;

  const marker = (): VaultMarker | undefined => readMarkers(o.account)[o.markerId];
  const patch = (p: Partial<VaultMarker>): void => {
    const m = marker();
    if (m && Object.entries(p).every(([k, v]) => m[k as keyof VaultMarker] === v)) return;
    updateMarker(o.account, o.markerId, p, now());
  };
  patch({ name: info.name, kind: o.kind, localPath: info.path });

  const offStatus = core.on('sync:status', (raw) => {
    const s = raw as SyncStatus;
    if (!s || s.vaultId !== info.id) return;
    if (s.phase === 'syncing') runStartedAt = Math.max(runStartedAt, now());
    const counts = {
      pending: typeof s.pending === 'number' ? s.pending : (marker()?.pending ?? 0),
      conflicts: typeof s.conflicts === 'number' ? s.conflicts : (marker()?.conflicts ?? 0),
    };
    const clean =
      s.phase === 'idle' &&
      counts.pending === 0 &&
      counts.conflicts === 0 &&
      runStartedAt > dirtyAt;
    if (clean) dirtyAt = 0;
    patch({ ...counts, ...(clean ? { dirty: false } : {}) });
  });

  const offChanged = core.on('vault:file-changed', (raw) => {
    const p = raw as { vaultId?: string } | undefined;
    if (p?.vaultId !== info.id) return;
    dirtyAt = now();
    patch({ dirty: true });
  });

  /** Removes the copy (files and databases) and its marker, then goes to the console. */
  const wipeAndLeave = async (): Promise<void> => {
    showOverlay({ busy: true, lines: [message('workbench.locking')] });
    await core.callWithin(60_000, 'VaultAPI', 'CloseVault', info.id).catch(() => undefined);
    try {
      await core.wipe(info.path);
      removeMarker(o.account, o.markerId);
    } catch (e) {
      // The marker stays: the next start-up sweep removes the copy.
      console.error('memobrain: could not remove the copy of the vault:', e);
    }
    o.goToConsole();
  };

  const keep = (counts: { pending: number; conflicts: number; dirty?: boolean }): void => {
    showLocked(counts, {
      unlock: o.reload,
      deleteCopy: () => void wipeAndLeave(),
      backToConsole: o.goToConsole,
    });
  };

  /** After a lock: remove the copy when the cloud has everything, otherwise keep it and say so. */
  const decide = async (p: Partial<VaultLockedPayload>): Promise<void> => {
    if (deciding) return;
    deciding = true;
    let { pending, conflicts } = p;
    if (typeof pending !== 'number' || typeof conflicts !== 'number') {
      const s = await core
        .callWithin<SyncStatus>(15_000, 'SyncAPI', 'Status', info.id)
        .catch(() => null);
      if (!s) {
        // Not knowing is not the same as nothing pending: keep the copy.
        const m = marker();
        return keep({ pending: m?.pending ?? 0, conflicts: m?.conflicts ?? 0, dirty: true });
      }
      ({ pending, conflicts } = s);
    }
    if (pending < 0 || conflicts < 0) {
      // The core could not count them (-1): unknown is kept, like changes.
      patch({ dirty: true });
      const m = marker();
      return keep({
        pending: Math.max(m?.pending ?? 0, 0),
        conflicts: Math.max(conflicts, m?.conflicts ?? 0, 0),
        dirty: true,
      });
    }
    patch({ pending, conflicts });
    if (pending === 0 && conflicts === 0) return wipeAndLeave();
    keep({ pending, conflicts });
  };

  const offLocked = isPrivate
    ? core.on('vault:locked', (raw) => {
        const p = raw as VaultLockedPayload | undefined;
        if (!p || p.vaultId !== info.id) return;
        // The sync loop also sends this event (reason "sync") while the vault waits for its
        // passphrase: only a lock counts. An older core gives no reason: then only the lock of a
        // vault unlocked in this page does.
        if (p.reason === undefined ? !unlocked : p.reason !== 'manual' && p.reason !== 'idle')
          return;
        unlocked = false;
        if (selfLock) {
          lockPayload = p;
          return;
        }
        void decide(p);
      })
    : () => undefined;

  /** Waits until the core reports nothing left to upload (or the time is up). */
  const drain = async (): Promise<void> => {
    const deadline = now() + (o.drainMs ?? 15_000);
    while (now() < deadline) {
      const s = await core
        .callWithin<SyncStatus>(5_000, 'SyncAPI', 'Status', info.id)
        .catch(() => null);
      if (!s || core.dead) return;
      if (s.pending === 0 && s.phase !== 'syncing') return;
      await sleep(o.pollMs ?? 500);
    }
  };

  const lockAndForget = (): Promise<void> => {
    // Already locked and decided: the overlay (or the way out) is on screen.
    if (deciding) return Promise.resolve();
    running ??= (async () => {
      showOverlay({ busy: true, lines: [message('workbench.locking')] });
      await o.flush();
      // The core knows whether the key is in memory; the page's own record is the fallback.
      const isUnlocked = await core
        .callWithin<{ locked?: boolean } | null>(10_000, 'SyncAPI', 'Info', info.id)
        .then((i) => (i ? !i.locked : unlocked))
        .catch(() => unlocked);
      if (!isUnlocked) {
        // Never unlocked in this page: nothing could be uploaded. A change made here while it was
        // locked is not counted by the core until a sync scans it, hence the marker's flag.
        const m = marker();
        if (m?.dirty) {
          const s = await core
            .callWithin<SyncStatus>(15_000, 'SyncAPI', 'Status', info.id)
            .catch(() => null);
          deciding = true;
          return keep({
            pending: s?.pending ?? m.pending,
            conflicts: s?.conflicts ?? m.conflicts,
            dirty: true,
          });
        }
        return decide({});
      }
      await core.callWithin(15_000, 'SyncAPI', 'SyncNow', info.id).catch(() => undefined);
      await drain();
      selfLock = true;
      lockPayload = null;
      try {
        // The core uploads what is pending (bounded) before it forgets the key.
        await core.callWithin(60_000, 'VaultCryptoAPI', 'Lock', info.id);
      } catch {
        // decide() asks the core for the counts; when it cannot answer, the copy is kept
      } finally {
        selfLock = false;
        unlocked = false;
      }
      return decide(lockPayload ?? {});
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const removeCopy = async (): Promise<void> => {
    if (isPrivate) return lockAndForget();
    if (running) return running;
    running = (async () => {
      showOverlay({ busy: true, lines: [message('workbench.removing')] });
      await o.flush();
      await core.callWithin(15_000, 'SyncAPI', 'SyncNow', info.id).catch(() => undefined);
      await drain();
      const s = await core
        .callWithin<SyncStatus>(15_000, 'SyncAPI', 'Status', info.id)
        .catch(() => null);
      if (s && s.pending === 0 && s.conflicts === 0) return wipeAndLeave();
      const counts = {
        pending: Math.max(s?.pending ?? marker()?.pending ?? 0, 0),
        conflicts: Math.max(s?.conflicts ?? marker()?.conflicts ?? 0, 0),
      };
      if (s) patch(counts);
      // Unknown counts are kept like changes (D-04): the user decides.
      const ask = (): void =>
        void showOverlay({
          title: message('workbench.removeKeptTitle'),
          lines: [
            ...unsyncedLines(counts.pending, counts.conflicts, !s),
            message('workbench.removeKeptHint'),
          ],
          actions: [
            { label: message('workbench.stay'), kind: 'primary', onClick: closeOverlay },
            {
              label: message('workbench.deleteAnyway'),
              kind: 'danger',
              onClick: () => confirmDelete(() => void wipeAndLeave(), ask),
            },
          ],
        });
      ask();
    })().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    noteUnlocked() {
      unlocked = true;
      deciding = false;
    },
    async leave() {
      if (isPrivate) return lockAndForget();
      await o.flush();
      o.goToConsole();
    },
    lockAndForget,
    deleteCopy: wipeAndLeave,
    removeCopy,
    dispose() {
      offStatus();
      offChanged();
      offLocked();
    },
  };
}

/** Whether the copy of `markerId` must be unlocked before the workbench may show it (see launch.ts). */
export function needsGate(
  account: string,
  markerId: string,
  kind: string,
  locked: boolean,
): VaultMarker | null {
  if (kind !== 'private' || !locked) return null;
  const m = readMarkers(account)[markerId];
  return m && unsynced(m) ? m : null;
}
