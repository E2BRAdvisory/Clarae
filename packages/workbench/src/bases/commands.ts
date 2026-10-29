// "New base": a minimal .base with a table of the notes of the current folder.
import { api } from '../app/api';
import { invalidateVault, uniqueName } from '../app/actions';
import { folderOf } from '../drawing/scene';
import { useAppStore } from '../state/store';
import { activeTab } from '../workspace/layout';

/** Creates a base next to the active note (or in opts.dir) and opens it. */
export async function newBase(opts: { dir?: string } = {}): Promise<string> {
  const { vault, layout } = useAppStore.getState();
  if (!vault) throw new Error('no vault is open');
  const tab = activeTab(layout);
  const dir = opts.dir ?? (tab ? folderOf(tab.path) : '');
  const tree = await api.vault.listTree(vault.id);
  const path = uniqueName(tree, dir, 'Base', '.base');
  await api.vault.writeNote(vault.id, path, await api.bases.newContent(dir), '');
  invalidateVault(vault.id);
  useAppStore.getState().openNote(path, { newTab: true });
  return path;
}
