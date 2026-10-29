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

/** The OPFS folders of the workbench (opfs-fs.ts and the sqlite pool in worker.ts). */
export const WORKBENCH_FOLDERS = ['fs', 'memobrain-sqlite'] as const;

export async function forgetThisBrowser(): Promise<ForgetResult> {
  // No OPFS (old browser, jsdom, an insecure origin): there is nothing of ours to remove.
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory)
    return { removed: true, busy: false };
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
  return { removed: !busy, busy };
}
