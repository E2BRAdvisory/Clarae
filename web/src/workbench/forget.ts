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
 *
 * During a deploy a tab of 1.4 may still be open next to this one. It knows the lock and the channel
 * by their old names (legacyNames.ts) and the account by its old key, so a workbench page holds both
 * locks, the requests to leave go out on both channels (each in the key its listener compares), and
 * what the account holds under the old names is removed with the rest (`legacyAccount`).
 */
import { LEGACY_WORKBENCH_CHANNEL, LEGACY_WORKBENCH_LOCK } from './legacyNames';
import { unsyncedVaults, type VaultMarker } from './markers';
import { removeAccountStorage, type RemoveResult } from './storage';

export type ForgetResult = RemoveResult;

/** A copy whose marker says it holds changes the cloud does not have (markers.ts unsyncedVaults). */
export type UnsyncedCopy = VaultMarker & { id: string };

/**
 * The Web Lock a workbench page holds while it is open (web/src/workbench/main.tsx): one workbench
 * per browser, since the synchronous handles of OPFS are exclusive.
 */
export const WORKBENCH_LOCK = 'clarae-workbench';

/**
 * Every lock a workbench page holds, in the order it takes them: the one of 1.4 first, so a 1.4 tab
 * and this page never both open the exclusive handles of OPFS.
 */
export const WORKBENCH_LOCKS: readonly string[] = [LEGACY_WORKBENCH_LOCK, WORKBENCH_LOCK];

/**
 * One attempt at taking every workbench lock (without waiting for any): true when this page now holds
 * them all, for as long as it lives. When one is taken by another page, the ones already got are
 * released and the result is false.
 */
export async function tryTakeWorkbenchLocks(locks: LockManager): Promise<boolean> {
  const releases: (() => void)[] = [];
  for (const name of WORKBENCH_LOCKS) {
    const release = await new Promise<(() => void) | null>((resolve) => {
      void locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        // Holding the lock means not settling: it is released when the page goes away (or on `release`).
        return new Promise<void>((done) => resolve(() => done()));
      });
    });
    if (!release) {
      releases.forEach((r) => r());
      return false;
    }
    releases.push(release);
  }
  return true;
}

/**
 * Whether a workbench page is open in this browser (any account, any version). Unknown (no Web
 * Locks) counts as open: callers then wait instead of trusting markers a page may still be updating.
 */
export async function workbenchPageOpen(): Promise<boolean> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.query) return true;
  try {
    const state = await locks.query();
    return (state.held ?? []).some((l) => l.name !== undefined && WORKBENCH_LOCKS.includes(l.name));
  } catch {
    return true;
  }
}

/**
 * Removes the storage and the markers of the account `account` (storage.ts accountKey), and what it
 * holds under `legacyAccount`, its key in 1.4 (storage.ts legacyAccountKey).
 */
export function forgetThisBrowser(account: string, legacyAccount?: string): Promise<ForgetResult> {
  return removeAccountStorage(account, legacyAccount);
}

/** The channel between the console and a workbench tab of the same browser. */
export const WORKBENCH_CHANNEL = 'clarae-workbench';

export interface LeaveRequest {
  type: 'leave';
  /**
   * The account whose workbench must leave: a tab of another account ignores the request. On the
   * channel of 1.4 it is the account's key in 1.4, the one a 1.4 tab compares.
   */
  account: string;
  /** Set on the copy sent to the channel of 1.4: a page of this version already got the other copy. */
  copy?: true;
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
export function askWorkbenchToLeave(
  account: string,
  discard = false,
  legacyAccount?: string,
): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const send = (name: string, request: LeaveRequest): void => {
    const ch = new BroadcastChannel(name);
    ch.postMessage(request);
    ch.close();
  };
  const rest = discard ? { discard } : {};
  send(WORKBENCH_CHANNEL, { type: 'leave', account, ...rest });
  // A tab of 1.4 listens on its own channel, for its own key of the account.
  if (legacyAccount)
    send(LEGACY_WORKBENCH_CHANNEL, { type: 'leave', account: legacyAccount, copy: true, ...rest });
}

/**
 * The workbench side of askWorkbenchToLeave, for the tab of `account` (`legacyAccount`: its key in 1.4);
 * returns the function that stops listening. It listens on the channel of 1.4 too, for a console of 1.4
 * that is still open (one of this version sends the same request on both channels: the copy on the
 * old one is skipped).
 */
export function onLeaveRequest(
  account: string,
  cb: (discard: boolean) => void,
  legacyAccount?: string,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const listen = (name: string, mine: string | undefined, old: boolean): BroadcastChannel => {
    const ch = new BroadcastChannel(name);
    ch.onmessage = (ev: MessageEvent<LeaveRequest>) => {
      const d = ev.data;
      if (d?.type !== 'leave' || mine === undefined || d.account !== mine) return;
      if (old && d.copy) return;
      cb(d.discard === true);
    };
    return ch;
  };
  const channels = [
    listen(WORKBENCH_CHANNEL, account, false),
    listen(LEGACY_WORKBENCH_CHANNEL, legacyAccount, true),
  ];
  return () => channels.forEach((c) => c.close());
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
  /** The account's key in 1.4: what it holds under the old names is removed and counted too. */
  legacyAccount?: string;
  forget?: (account: string, legacyAccount?: string) => Promise<ForgetResult>;
  /** The copies with changes not uploaded (default: the account's markers, the old ones included). */
  unsynced?: (account: string, legacyAccount?: string) => UnsyncedCopy[];
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
  askWorkbenchToLeave(account, o.discard, o.legacyAccount);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!o.discard) {
      const left = unsynced(account, o.legacyAccount).filter((v) => !accepted.has(v.id));
      if (left.length > 0) {
        const open = await pageOpen().catch(() => true);
        // The page is gone: what its markers say is final, and the user decides.
        if (!open) return { removed: false, busy: false, unsynced: left };
        if (Date.now() >= deadline) return { removed: false, busy: true, unsynced: left };
        continue; // still uploading, or keeping them: wait
      }
    }
    const r = await forget(account, o.legacyAccount);
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
    const first = await forget(account, o.legacyAccount);
    if (!first.busy) return first.removed;
    const r = await forgetAfterLeave(account, { timeoutMs: 10_000, ...o, discard: true });
    return r.removed;
  } catch (e) {
    console.error('clarae: could not remove the vault copies of the deleted account:', e);
    return false;
  }
}
