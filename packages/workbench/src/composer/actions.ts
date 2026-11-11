// Note composer: merge the active note into another, or extract the selection into a new note.
import i18next from 'i18next';
import { invalidateVault } from '../app/actions';
import { api } from '../app/api';
import { useNotesSettings } from '../daily/settings';
import { getActiveEditor } from '../editor/registry';
import { useActiveNote } from '../state/activeNote';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { activeTab } from '../workspace/layout';

const stem = (p: string): string => p.replace(/^.*\//, '').replace(/\.md$/, '');

/**
 * Merges the active note (source) into a note chosen by the user: the source's text is appended
 * to it, every link to the source is redirected and the source goes to the trash. The user sees
 * "N links in M notes" before anything is changed, like for a rename.
 */
export async function mergeActiveNote(): Promise<void> {
  const state = useAppStore.getState();
  const vault = state.vault;
  const source = activeTab(state.layout)?.path;
  if (!vault || !source || !source.toLowerCase().endsWith('.md')) return;
  const s = await useNotesSettings.getState().ready(vault.id);
  const tree = await api.vault.listTree(vault.id);
  const candidates = tree.filter(
    (e) =>
      !e.isDir &&
      e.path.toLowerCase().endsWith('.md') &&
      e.path !== source &&
      !e.path.startsWith('.trash/') &&
      !e.path.startsWith('.memobrain/'),
  );
  const target = await dialog.pick(
    i18next.t('composer.mergePick', { name: stem(source) }),
    candidates.map((e) => ({ value: e.path, label: e.path.replace(/\.md$/, '') })),
  );
  if (!target) return;
  // Pending edits of the source must be on disk before they are copied.
  const active = useActiveNote.getState().note;
  if (active?.path === source) {
    try {
      await active.prepare();
    } catch (e) {
      await dialog.error(e); // edits that cannot be saved (a conflict) are not merged nor lost
      return;
    }
  }
  const plan = await api.composer.planMerge(vault.id, source, target);
  const ok = await dialog.confirm(
    i18next.t('composer.mergeTitle'),
    i18next.t('composer.mergeConfirm', {
      source: stem(source),
      target: stem(target),
      links: plan.links,
      notes: plan.notes,
    }),
    true,
  );
  if (!ok) return;
  try {
    await api.composer.applyMerge(vault.id, source, target, s.mergeSeparator);
  } catch (e) {
    // The content is merged even when the source could not be trashed: show where things stand.
    invalidateVault(vault.id);
    await dialog.error(e);
    return;
  }
  useAppStore.getState().pathRemoved(source);
  invalidateVault(vault.id);
  useAppStore.getState().openNote(target);
}

/** Moves the selection of the active editor into a new note and leaves a link (or embed) behind. */
export async function extractSelection(): Promise<void> {
  const view = getActiveEditor();
  const state = useAppStore.getState();
  const vault = state.vault;
  const source = activeTab(state.layout)?.path;
  if (!view || !vault || !source) return;
  const text = view.selectionMarkdown();
  if (!text.trim()) {
    await dialog.alert(i18next.t('composer.extractTitle'), i18next.t('composer.noSelection'));
    return;
  }
  const s = await useNotesSettings.getState().ready(vault.id);
  const suggested = await api.composer.suggestTitle(text);
  const title = await dialog.prompt(i18next.t('composer.extractPrompt'), suggested);
  if (title === null) return;
  const res = await api.composer.extract(vault.id, {
    sourcePath: source,
    selection: text,
    title,
    dir: '',
    embed: s.extractEmbed,
    carryFrontmatter: s.extractFrontmatter,
  });
  // The selection may have moved while the dialogs were open: replace it only if it is intact.
  if (!view.replaceSelectionIf(text, res.link)) {
    await dialog.alert(
      i18next.t('composer.extractTitle'),
      i18next.t('composer.selectionChanged', { path: res.path }),
    );
  }
  invalidateVault(vault.id);
  view.focus();
}
