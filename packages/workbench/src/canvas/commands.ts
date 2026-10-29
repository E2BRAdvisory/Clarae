// "New canvas" (M3-WP3): same flow as a new drawing.
import { api } from '../app/api';
import { invalidateVault, uniqueName } from '../app/actions';
import { insertIntoActiveNote } from '../drawing/commands';
import { drawingBaseName, embedMarkdown, folderOf } from '../drawing/scene';
import { useAppStore } from '../state/store';
import { activeTab } from '../workspace/layout';

export const EMPTY_CANVAS = '{\n\t"nodes": [],\n\t"edges": []\n}';

/** Creates an empty .canvas next to the active note, embeds it there when editing, opens it. */
export async function newCanvas(opts: { dir?: string } = {}): Promise<string> {
  const { vault, layout } = useAppStore.getState();
  if (!vault) throw new Error('no vault is open');
  const tab = activeTab(layout);
  const tree = await api.vault.listTree(vault.id);
  const base = drawingBaseName(new Date()).replace(/^Drawing/, 'Canvas');
  const path = uniqueName(tree, opts.dir ?? (tab ? folderOf(tab.path) : ''), base, '.canvas');
  await api.vault.writeNote(vault.id, path, EMPTY_CANVAS, '');
  invalidateVault(vault.id);
  if (opts.dir === undefined && tab && tab.mode !== 'reading')
    insertIntoActiveNote(embedMarkdown(path));
  useAppStore.getState().openNote(path, { newTab: true });
  return path;
}
