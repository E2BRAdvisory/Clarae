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
import { removeAccountStorage, type RemoveResult } from './storage';

export type ForgetResult = RemoveResult;

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
  /** See LeaveRequest.discard. */
  discard?: boolean;
  forget?: (account: string) => Promise<ForgetResult>;
}

/**
 * Tries to forget the account's storage for up to `timeoutMs` while its workbench tab, asked to leave,
 * releases the files. Resolves to the last result (still `busy` when the tab did not leave, e.g. it
 * keeps changes).
 */
export async function forgetAfterLeave(
  account: string,
  o: LeaveOptions = {},
): Promise<ForgetResult> {
  const { timeoutMs = 20_000, intervalMs = 1_000, forget = forgetThisBrowser } = o;
  askWorkbenchToLeave(account, o.discard);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
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
