/**
 * Removes what the vault workbench keeps in this browser for an account: the copies of its vaults and
 * the databases that index and track them (its storage, see storage.ts), and its markers. Signing out
 * does this, so a shared computer is left without a clear-text copy of the account's vaults (ADR-0029);
 * the next sign-in downloads the vaults again. Other accounts' copies are not touched: each account
 * removes its own when it signs out or forgets the browser.
 *
 * It runs on the console page, where no worker holds the files. When a workbench tab of the account is
 * open elsewhere its handles keep the files locked and nothing is removed: `busy` says so, and the
 * caller can tell the user.
 */
import { unsyncedVaults, type VaultMarker } from './markers';
import { removeAccountStorage, type RemoveResult } from './storage';

export type ForgetResult = RemoveResult;

/** A copy whose marker says it holds changes the cloud does not have (markers.ts unsyncedVaults). */
export type UnsyncedCopy = VaultMarker & { id: string };

/**
 * The Web Lock a workbench page holds while it is open (web/src/workbench/main.tsx): one workbench
 * per browser, since the synchronous handles of OPFS are exclusive.
 */
export const WORKBENCH_LOCK = 'memobrain-workbench';

/**
 * Whether a workbench page is open in this browser (any account). Unknown (no Web Locks) counts as
 * open: callers then wait instead of trusting markers a page may still be updating.
 */
export async function workbenchPageOpen(): Promise<boolean> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.query) return true;
  try {
    const state = await locks.query();
    return (state.held ?? []).some((l) => l.name === WORKBENCH_LOCK);
  } catch {
    return true;
  }
}

/** Removes the storage and the markers of the account `account` (storage.ts accountKey). */
export function forgetThisBrowser(account: string): Promise<ForgetResult> {
  return removeAccountStorage(account);
}

/** The channel between the console and a workbench tab of the same browser. */
export const WORKBENCH_CHANNEL = 'memobrain-workbench';

export interface LeaveRequest {
  type: 'leave';
  /** The account whose workbench must leave: a tab of another account ignores the request. */
  account: string;
  /**
   * Leave without uploading or keeping anything (the account was deleted: nothing can be uploaded
   * any more, and the copies must go): the tab stops its engine at once.
   */
  discard?: boolean;
}

/**
 * Asks a workbench of the account open in another tab to leave (upload, lock and remove what it can,
 * then go back to the console; or stop at once with `discard`), which releases the files so they can
 * be removed. Nothing happens without such a tab.
 */
export function askWorkbenchToLeave(account: string, discard = false): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(WORKBENCH_CHANNEL);
  ch.postMessage({
    type: 'leave',
    account,
    ...(discard ? { discard } : {}),
  } satisfies LeaveRequest);
  ch.close();
}

/**
 * The workbench side of askWorkbenchToLeave, for the tab of `account`; returns the function that stops
 * listening.
 */
export function onLeaveRequest(account: string, cb: (discard: boolean) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const ch = new BroadcastChannel(WORKBENCH_CHANNEL);
  ch.onmessage = (ev: MessageEvent<LeaveRequest>) => {
    if (ev.data?.type === 'leave' && ev.data.account === account) cb(ev.data.discard === true);
  };
  return () => ch.close();
}

export interface LeaveOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** See LeaveRequest.discard: nothing is checked, everything goes. */
  discard?: boolean;
  /**
   * Ids of copies the user already agreed to lose (the confirmation listed them): they do not stop
   * the removal. Any other copy with changes does.
   */
  accepted?: readonly string[];
  forget?: (account: string) => Promise<ForgetResult>;
  /** The copies with changes not uploaded (default: the account's markers). */
  unsynced?: (account: string) => UnsyncedCopy[];
  /** Whether a workbench page is still open (default: its Web Lock, workbenchPageOpen). */
  pageOpen?: () => Promise<boolean>;
}

/** What forgetAfterLeave ends with: `unsynced` lists the copies that stopped it (not removed). */
export interface LeaveResult extends ForgetResult {
  unsynced?: UnsyncedCopy[];
}

/**
 * Tries to forget the account's storage for up to `timeoutMs` while its workbench tab, asked to leave,
 * uploads what it can and releases the files. Nothing is removed while a marker says a copy holds
 * changes the user did not agree to lose (D-04, ADR-0029): the tab may still be uploading them, and
 * once no workbench page is open the markers are final, so the result lists them (`unsynced`) for the
 * caller to ask. Resolves to the last result (still `busy` when the tab did not leave, e.g. it keeps
 * changes).
 */
export async function forgetAfterLeave(
  account: string,
  o: LeaveOptions = {},
): Promise<LeaveResult> {
  const {
    timeoutMs = 30_000,
    intervalMs = 1_000,
    forget = forgetThisBrowser,
    unsynced = unsyncedVaults,
    pageOpen = workbenchPageOpen,
  } = o;
  const accepted = new Set(o.accepted ?? []);
  askWorkbenchToLeave(account, o.discard);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!o.discard) {
      const left = unsynced(account).filter((v) => !accepted.has(v.id));
      if (left.length > 0) {
        const open = await pageOpen().catch(() => true);
        // The page is gone: what its markers say is final, and the user decides.
        if (!open) return { removed: false, busy: false, unsynced: left };
        if (Date.now() >= deadline) return { removed: false, busy: true, unsynced: left };
        continue; // still uploading, or keeping them: wait
      }
    }
    const r = await forget(account);
    if (!r.busy || Date.now() >= deadline) return r;
  }
}

/**
 * After the account was deleted: removes its storage without asking (nothing can be uploaded any
 * more), stopping its workbench tab if one holds the files. Never rejects; resolves to whether the
 * copies are gone.
 */
export async function discardAccountStorage(
  account: string,
  o: Omit<LeaveOptions, 'discard'> = {},
): Promise<boolean> {
  try {
    const forget = o.forget ?? forgetThisBrowser;
    const first = await forget(account);
    if (!first.busy) return first.removed;
    const r = await forgetAfterLeave(account, { timeoutMs: 10_000, ...o, discard: true });
    return r.removed;
  } catch (e) {
    console.error('memobrain: could not remove the vault copies of the deleted account:', e);
    return false;
  }
}
