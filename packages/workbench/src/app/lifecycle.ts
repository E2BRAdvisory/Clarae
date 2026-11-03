// Teardown of the whole workbench: the desktop window closing, the Web UI page being left. Pending
// edits are written first (D-04), within a bounded time so leaving can never hang on a stuck write.
import { Quit } from '../../wailsjs/runtime/runtime';
import { installActivityFeed } from './activity';
import { api } from './api';
import { Events } from './events';
import { usePlatform, type Capabilities } from '../platform';
import { saveWorkspaceNow } from '../shell/useVaultSession';
import { useAppStore } from '../state/store';
import { flushAllNotes, hasUnsavedNotes, withTimeout } from '../workspaces/flush';

/** How long an exit waits for the pending writes (the desktop host gives up a few seconds later). */
export const EXIT_FLUSH_MS = 5_000;

/**
 * Writes every pending edit (edits that cannot be saved in their file go to a copy next to it) and
 * the workspace layout. Resolves after `timeoutMs` at the latest; never rejects.
 */
export async function flushWorkbench(timeoutMs = EXIT_FLUSH_MS): Promise<void> {
  await withTimeout(
    (async () => {
      const report = await flushAllNotes({ rescue: true });
      if (report.failed.length)
        console.error('memobrain: unsaved edits could not be written:', report.failed.join(', '));
      const vault = useAppStore.getState().vault;
      if (vault) await saveWorkspaceNow(vault.id);
    })(),
    timeoutMs,
  );
}

/**
 * Hooks the workbench to the host's teardown; returns the function that unhooks it. It follows the
 * capabilities of the host (by default those mountWorkbench configured):
 * - a native window (the desktop): the Go host holds the first close request and emits
 *   `app:before-close`; the workbench flushes and asks to quit again (the host quits anyway if it
 *   never hears back);
 * - a page (the browser): leaving it with unsaved edits asks the browser to confirm;
 * - both: a hidden window (minimized, tab switched or being closed) starts writing at once, and user
 *   input restarts the idle lock timer of private vaults (app/activity).
 */
export function installLifecycle(
  caps: Pick<Capabilities, 'nativeWindow'> = usePlatform.getState().capabilities,
): () => void {
  const offs: (() => void)[] = [];
  if (caps.nativeWindow) {
    let closing = false;
    offs.push(
      api.on(Events.appBeforeClose, () => {
        if (closing) return;
        closing = true;
        void flushWorkbench().finally(() => Quit());
      }),
    );
  } else {
    const beforeUnload = (e: BeforeUnloadEvent): void => {
      const unsaved = hasUnsavedNotes();
      // Also the settings, bookmarks and library changes still waiting for their delay.
      void flushAllNotes();
      if (unsaved) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    offs.push(() => window.removeEventListener('beforeunload', beforeUnload));
  }
  // Hidden: documents with edits and the configuration writes waiting for their delay go now.
  const onHidden = (): void => {
    if (document.visibilityState === 'hidden') void flushAllNotes();
  };
  document.addEventListener('visibilitychange', onHidden);
  offs.push(() => document.removeEventListener('visibilitychange', onHidden));
  offs.push(installActivityFeed());
  return () => offs.forEach((off) => off());
}
