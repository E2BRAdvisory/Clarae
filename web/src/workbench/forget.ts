/**
 * Removes what the vault workbench keeps in this browser: the copies of the vaults (OPFS folder `fs`) and
 * the databases that index and track them (the SQLite pool, `memobrain-sqlite`). Signing out does this, so a
 * shared computer is left without a clear-text copy of anyone's vault (ADR-0029); the next sign-in downloads
 * the vaults again.
 *
 * It runs on the console page, where no worker holds the files. When a workbench tab is open elsewhere its
 * handles keep the files locked and nothing is removed: `busy` says so, and the caller can tell the user.
 */
export interface ForgetResult {
  /** True when there was nothing to remove or it was all removed. */
  removed: boolean;
  /** True when a workbench open in another tab holds the files. */
  busy: boolean;
}

import { clearMarkers } from './markers';

/** The OPFS folders of the workbench (opfs-fs.ts and the sqlite pool in worker.ts). */
export const WORKBENCH_FOLDERS = ['fs', 'memobrain-sqlite'] as const;

export async function forgetThisBrowser(): Promise<ForgetResult> {
  // No OPFS (old browser, jsdom, an insecure origin): there is nothing of ours to remove.
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    clearMarkers();
    return { removed: true, busy: false };
  }
  let busy = false;
  const root = await navigator.storage.getDirectory();
  for (const name of WORKBENCH_FOLDERS) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch (e) {
      const err = (e as { name?: string }).name;
      if (err === 'NotFoundError') continue;
      if (err === 'NoModificationAllowedError' || err === 'InvalidStateError') busy = true;
      else throw e;
    }
  }
  // The copies are gone, and with them what the markers described.
  if (!busy) clearMarkers();
  return { removed: !busy, busy };
}

/** The channel between the console and a workbench tab of the same browser. */
export const WORKBENCH_CHANNEL = 'memobrain-workbench';

interface LeaveRequest {
  type: 'leave';
}

/**
 * Asks a workbench open in another tab to leave (upload, lock and remove what it can, then go back to the
 * console), which releases the files so they can be removed. Nothing happens without such a tab.
 */
export function askWorkbenchToLeave(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(WORKBENCH_CHANNEL);
  ch.postMessage({ type: 'leave' } satisfies LeaveRequest);
  ch.close();
}

/** The workbench side of askWorkbenchToLeave; returns the function that stops listening. */
export function onLeaveRequest(cb: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const ch = new BroadcastChannel(WORKBENCH_CHANNEL);
  ch.onmessage = (ev: MessageEvent<LeaveRequest>) => {
    if (ev.data?.type === 'leave') cb();
  };
  return () => ch.close();
}

/**
 * Tries to forget this browser for up to `timeoutMs` while a workbench tab, asked to leave, releases the
 * files. Resolves to the last result (still `busy` when the tab did not leave, e.g. it keeps changes).
 */
export async function forgetAfterLeave(
  timeoutMs = 20_000,
  intervalMs = 1_000,
  forget: () => Promise<ForgetResult> = forgetThisBrowser,
): Promise<ForgetResult> {
  askWorkbenchToLeave();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const r = await forget();
    if (!r.busy || Date.now() >= deadline) return r;
  }
}
