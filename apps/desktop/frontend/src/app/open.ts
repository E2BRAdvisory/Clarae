import { api } from './api';
import { useAppStore } from '../state/store';
import type { OpenRequestPayload } from './events';

/**
 * Handles a nodus://open request: opens the vault when it is not the current
 * one (matched by name, then by path or id), then the file.
 */
export async function followLinkPath(
  req: OpenRequestPayload,
  openVault: (path: string) => Promise<void>,
): Promise<void> {
  const st = useAppStore.getState();
  if (req.vault && st.vault?.name !== req.vault && st.vault?.id !== req.vault) {
    const recent = await api.vault.listRecent();
    const found = recent.find(
      (v) => v.name === req.vault || v.id === req.vault || v.path === req.vault,
    );
    if (!found) return;
    await openVault(found.path);
  }
  if (req.file)
    useAppStore
      .getState()
      .openNote(req.file.endsWith('.md') || req.file.includes('.') ? req.file : `${req.file}.md`);
}
