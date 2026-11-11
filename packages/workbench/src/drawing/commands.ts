// Commands that create and insert drawings (M3-WP1).
import i18next from 'i18next';
import { api } from '../app/api';
import { invalidateVault, uniqueName } from '../app/actions';
import { getActiveEditor } from '../editor/registry';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { activeTab } from '../workspace/layout';
import { useSettings } from '../state/settings';
import { embedMarkdown, EMPTY_DRAWING } from './scene';
import { drawingDir, drawingName, useDrawingSettings } from './settings';

/** Inserts text at the cursor of the note being edited; false when no editor is open. */
export function insertIntoActiveNote(text: string): boolean {
  const view = getActiveEditor();
  if (!view) return false;
  view.replaceSelection(text);
  view.focus();
  return true;
}

/**
 * "New drawing": creates an empty .excalidraw in `dir`, or next to the active note (vault root
 * otherwise),
 * embeds it in the note when one is being edited, and opens it in a new tab.
 */
export async function newDrawing(opts: { dir?: string } = {}): Promise<string> {
  const { vault, layout } = useAppStore.getState();
  if (!vault) throw new Error('no vault is open');
  const tab = activeTab(layout);
  const cfg = useDrawingSettings.getState().settings;
  const dir = opts.dir ?? drawingDir(cfg, useSettings.getState().editor, tab ? tab.path : null);
  const tree = await api.vault.listTree(vault.id);
  const path = uniqueName(tree, dir, drawingName(cfg, new Date()), '.excalidraw');
  await api.vault.writeNote(vault.id, path, EMPTY_DRAWING, '');
  invalidateVault(vault.id);
  if (opts.dir === undefined && tab && tab.mode !== 'reading')
    insertIntoActiveNote(embedMarkdown(path, cfg.embedWidth));
  useAppStore.getState().openNote(path, { newTab: true });
  return path;
}

/** "Insert drawing": pick an existing drawing and embed it in the note being edited. */
export async function insertDrawing(): Promise<void> {
  const { vault } = useAppStore.getState();
  if (!vault) return;
  const drawings = (await api.vault.listTree(vault.id)).filter(
    (e) => !e.isDir && e.path.toLowerCase().endsWith('.excalidraw'),
  );
  if (drawings.length === 0)
    return dialog.alert(i18next.t('drawing.insert'), i18next.t('drawing.none'));
  const picked = await dialog.pick(
    i18next.t('drawing.insert'),
    drawings.map((d) => ({ value: d.path, label: d.path.replace(/\.excalidraw$/i, '') })),
  );
  if (picked)
    insertIntoActiveNote(embedMarkdown(picked, useDrawingSettings.getState().settings.embedWidth));
}
