/**
 * Keeps watch over the vault open in the workbench page:
 * - its marker (markers.ts) follows the core's sync events, so the console and the next start-up know
 *   whether the copy in this browser holds changes the cloud does not have;
 * - for a private vault, a lock (manual or the core's idle timer, ADR-0029 §6) removes the clear-text copy
 *   from the browser and goes back to the console, unless that would lose changes (D-04): then a blocking
 *   overlay says what is kept and lets the user unlock, delete anyway or leave the copy for later;
 * - leaving (back to the console, another page of the workbench, signing out, a request from the
 *   console) uploads what it can first, and records in the marker what could not be uploaded;
 * - when the cloud vault is deleted elsewhere (`vault:cloud-deleted`) the copy can no longer upload: the
 *   marker says so and the copy is removed only by what the marker records (the UI offers it).
 *
 * Whether a copy may be removed without losing changes is the core's decision (SyncAPI.CopyVerdict,
 * ADR-0045 point 8): it scans the files first, so a change no sync has seen counts. The guard removes the
 * files and keeps the marker, the only record the console has (it runs without a core) and the only one
 * left once the core disconnected a folder whose cloud vault was deleted.
 */
import { Events, type EventPayloads } from '@memobrain/workbench/events';
import type { CoreHandle } from './bridge';
import type { sync } from '@memobrain/workbench/wailsjs/models';
import { coreClient, type Data } from './core.gen';
import { readMarkers, removeMarker, unsynced, updateMarker, type VaultMarker } from './markers';
import { closeOverlay, confirmDelete, showLocked, showOverlay, unsyncedLines } from './overlay';
import { message } from './strings';

/**
 * Payload of the core's `vault:locked` event (sync.LockedEvent, generated; older cores send only
 * `vaultId`). It is emitted once the key left memory; `pending` is -1 when the core could not count the
 * changes. Reason "sync" is not a lock: the sync loop repeats it while the vault waits for its passphrase.
 */
export type VaultLockedPayload = Pick<EventPayloads['vault:locked'], 'vaultId'> &
  Partial<EventPayloads['vault:locked']>;

/** `sync:status` (sync.Status); `kind` is "private" or "shared" while linked, "" once unlinked. */
type SyncStatus = Pick<EventPayloads['sync:status'], 'vaultId' | 'pending' | 'conflicts'> & {
  phase: string;
  kind?: string;
};

/**
 * A status of a folder that is not linked to the cloud (any more): it says nothing about uploads
 * (its zero counts are not "everything uploaded"), so it never updates the marker.
 */
const unlinkedStatus = (s: SyncStatus | null | undefined): boolean => s?.kind === '';

/**
 * The core's verdict on removing the copy: `reason` is "clean", "pending", "conflicts", "unknown" or
 * "unlinked"; the counts are -1 when unknown.
 */
type CopyVerdict = Data<sync.CopyVerdict>;

/** How long the verdict may take: it scans the copy's files. */
const VERDICT_MS = 60_000;

/** Phases after which waiting longer uploads nothing soon: offline, paused, failed. */
const STALLED = new Set(['offline', 'paused', 'error']);

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
  /**
   * Leaves for the console, or for `to` (another page of the workbench): writes the edits and
   * uploads what is pending (bounded), recording in the marker what is left; a private vault is
   * locked and its copy removed (lockAndForget).
   */
  leave(to?: () => void): Promise<void>;
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
  /** The core's bindings with a time limit (core.gen.ts). */
  const within = (ms: number) => coreClient(core, ms);
  const now = o.now ?? Date.now;
  const isPrivate = o.kind === 'private';
  let unlocked = false;
  let selfLock = false;
  let lockPayload: VaultLockedPayload | null = null;
  let running: Promise<void> | null = null;
  let deciding = false;
  // The cloud vault was deleted elsewhere: the core disconnected the folder, nothing uploads any more.
  let detached = false;
  // Where leaving goes once the copy is dealt with (the console unless leave() was given a page).
  let destination: (() => void) | null = null;
  const go = (): void => (destination ?? o.goToConsole)();

  // A change the core may not have scanned yet: cleared by a sync that started after it and ended clean.
  let dirtyAt = readMarkers(o.account)[o.markerId]?.dirty ? now() : 0;
  let runStartedAt = 0;

  const marker = (): VaultMarker | undefined => readMarkers(o.account)[o.markerId];
  /** The core's verdict on removing the copy; null when it could not answer (kept like changes). */
  const verdict = (): Promise<CopyVerdict | null> =>
    within(VERDICT_MS)
      .SyncAPI.CopyVerdict(info.id)
      .then((v): CopyVerdict | null => v ?? null)
      .catch(() => null);
  const patch = (p: Partial<VaultMarker>): void => {
    const m = marker();
    if (m && Object.entries(p).every(([k, v]) => m[k as keyof VaultMarker] === v)) return;
    updateMarker(o.account, o.markerId, p, now());
  };
  // Linked (again: a vault restored after its deletion and opened anew): the marker follows it.
  patch({
    name: info.name,
    kind: o.kind,
    localPath: info.path,
    ...(marker()?.cloudDeleted ? { cloudDeleted: false } : {}),
  });

  const offStatus = core.on(Events.syncStatus, (raw) => {
    const s = raw as SyncStatus;
    if (!s || s.vaultId !== info.id || detached || unlinkedStatus(s)) return;
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

  const offChanged = core.on(Events.vaultFileChanged, (raw) => {
    const p = raw as { vaultId?: string } | undefined;
    if (p?.vaultId !== info.id) return;
    dirtyAt = now();
    patch({ dirty: true });
  });

  // Deleted from the console or another device: the core disconnected the folder, which keeps its
  // files. What the marker records can no longer be uploaded; the workbench offers to remove the copy
  // (onRemoveFromBrowser), and a restored vault opened again links it anew.
  const offDeleted = core.on(Events.vaultCloudDeleted, (raw) => {
    const p = raw as { vaultId?: string } | undefined;
    if (p?.vaultId !== info.id) return;
    detached = true;
    patch({ cloudDeleted: true });
  });

  /** Removes the copy (files and databases) and its marker, then leaves (console or `to`). */
  const wipeAndLeave = async (): Promise<void> => {
    showOverlay({ busy: true, lines: [message('workbench.locking')] });
    await within(60_000)
      .VaultAPI.CloseVault(info.id)
      .catch(() => undefined);
    try {
      await core.wipe(info.path);
      removeMarker(o.account, o.markerId);
    } catch (e) {
      // The marker stays: the next start-up sweep removes the copy.
      console.error('memobrain: could not remove the copy of the vault:', e);
    }
    go();
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
      // No counts with the event: the core's verdict scans and counts.
      const v = await verdict();
      if (!v || v.reason === 'unlinked') {
        // Not knowing is not the same as nothing pending: keep the copy.
        const m = marker();
        return keep({ pending: m?.pending ?? 0, conflicts: m?.conflicts ?? 0, dirty: true });
      }
      ({ pending, conflicts } = v);
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
    // Counts the core took after a scan (the lock's event, or the verdict): nothing pending and no
    // conflict is a copy the cloud has entirely.
    patch({ pending, conflicts, dirty: false });
    if (pending === 0 && conflicts === 0) return wipeAndLeave();
    keep({ pending, conflicts });
  };

  const offLocked = isPrivate
    ? core.on(Events.vaultLocked, (raw) => {
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
      const s: SyncStatus | null = await within(5_000)
        .SyncAPI.Status(info.id)
        .catch(() => null);
      if (!s || core.dead || unlinkedStatus(s)) return;
      if (s.pending === 0 && s.phase !== 'syncing') return;
      // The cycle asked for (SyncNow) ended without uploading everything and the next one waits for
      // the network or a back-off: what is left is decided now, never deleted unasked.
      if (STALLED.has(s.phase)) return;
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
      const isUnlocked = await within(10_000)
        .SyncAPI.Info(info.id)
        .then((i: { locked?: boolean } | null) => (i ? !i.locked : unlocked))
        .catch(() => unlocked);
      if (!isUnlocked) {
        // Never unlocked in this page: nothing could be uploaded. The core's verdict scans the copy
        // (no key needed), so a change made here while it was locked counts.
        return decide({});
      }
      await within(15_000)
        .SyncAPI.SyncNow(info.id)
        .catch(() => undefined);
      await drain();
      selfLock = true;
      lockPayload = null;
      try {
        // The core uploads what is pending (bounded) before it forgets the key.
        await within(60_000).VaultCryptoAPI.Lock(info.id);
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

  /** Keeps a copy that holds what the cloud does not have and lets the user stay or delete it. */
  const askBeforeRemoving = (
    counts: { pending: number; conflicts: number },
    unknown: boolean,
  ): void => {
    const ask = (): void =>
      void showOverlay({
        title: message('workbench.removeKeptTitle'),
        lines: [
          ...unsyncedLines(counts.pending, counts.conflicts, unknown),
          message(detached ? 'workbench.removeDeletedHint' : 'workbench.removeKeptHint'),
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
  };

  /**
   * A copy that can no longer upload (its cloud vault was deleted, or the folder is not linked): the
   * marker is all that says what it holds. Removed when it records nothing, otherwise kept and asked.
   */
  const removeByMarker = (): void => {
    const m = marker();
    if (!m || !unsynced(m)) return void wipeAndLeave();
    askBeforeRemoving(
      { pending: Math.max(m.pending, 0), conflicts: Math.max(m.conflicts, 0) },
      m.dirty,
    );
  };

  const removeCopy = async (): Promise<void> => {
    destination = null; // removing always ends in the console
    if (running) return running;
    if (detached) {
      running = (async () => {
        await o.flush();
        removeByMarker();
      })().finally(() => {
        running = null;
      });
      return running;
    }
    if (isPrivate) return lockAndForget();
    running = (async () => {
      showOverlay({ busy: true, lines: [message('workbench.removing')] });
      await o.flush();
      await within(15_000)
        .SyncAPI.SyncNow(info.id)
        .catch(() => undefined);
      await drain();
      const v = await verdict();
      // Disconnected meanwhile (deleted elsewhere): the core no longer vouches for the copy.
      if (detached || v?.reason === 'unlinked') return removeByMarker();
      if (v?.removable) return wipeAndLeave();
      const known = v !== null && v.reason !== 'unknown';
      const counts = {
        pending: Math.max(known ? v.pending : (marker()?.pending ?? 0), 0),
        conflicts: Math.max(known ? v.conflicts : (marker()?.conflicts ?? 0), 0),
      };
      if (known) patch({ ...counts, dirty: false });
      // Unknown counts are kept like changes (D-04): the user decides.
      askBeforeRemoving(counts, !known);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  /**
   * Leaving a vault that is not private: the edits are written and uploaded (bounded), and the
   * marker records what is left, so the console asks before deleting it (signing out, "forget this
   * browser") instead of finding a clean marker and a copy holding the last edits (D-04).
   */
  const leaveShared = (): Promise<void> => {
    if (running) return running;
    running = (async () => {
      showOverlay({ busy: true, lines: [message('workbench.leaving')] });
      await o.flush();
      if (!detached) {
        await within(15_000)
          .SyncAPI.SyncNow(info.id)
          .catch(() => undefined);
        await drain();
        // The core's verdict counts what is left after a scan: the marker is exact for the console.
        const v = await verdict();
        if (!v || v.reason === 'unknown')
          patch({ dirty: true }); // not knowing is kept like changes
        else if (!detached && v.reason !== 'unlinked')
          patch({ pending: v.pending, conflicts: v.conflicts, dirty: false });
      }
      go();
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
    async leave(to) {
      destination = to ?? null;
      if (detached) {
        // Nothing uploads any more. A private copy is clear text: it goes unless it holds changes.
        await o.flush();
        const m = marker();
        if (isPrivate && (!m || !unsynced(m))) return wipeAndLeave();
        return go();
      }
      if (isPrivate) return lockAndForget();
      return leaveShared();
    },
    lockAndForget,
    deleteCopy: wipeAndLeave,
    removeCopy,
    dispose() {
      offStatus();
      offChanged();
      offLocked();
      offDeleted();
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
