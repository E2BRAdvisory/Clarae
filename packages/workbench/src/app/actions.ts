// High-level operations used by both the UI and the command registry.
import i18next from 'i18next';
import { api, errorCode, type Entry } from './api';
import { applyTheme, effectiveTheme, type Theme } from './theme';
import { useBookmarks } from '../bookmarks/store';
import { uiLang } from '../daily/actions';
import { useNotesSettings } from '../daily/settings';
import { queryClient } from '../state/queryClient';
import { queryKeys } from '../state/queries';
import { useSettings } from '../state/settings';
import { newNoteDir, folderOf } from '../settings/locations';
import { selectActivePath, useAppStore } from '../state/store';
import { saveWorkspaceNow } from '../shell/useVaultSession';
import { dialog } from '../ui/dialogs';
import { flushAllNotes, settleNotes } from '../workspaces/flush';
import { splitName } from '../embeds/media';

function vaultId(): string {
  const v = useAppStore.getState().vault;
  if (!v) throw new Error('no vault is open');
  return v.id;
}

export function invalidateVault(id: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.tree(id) });
  void queryClient.invalidateQueries({ queryKey: ['search', id] });
  void queryClient.invalidateQueries({ queryKey: ['backlinks', id] });
  void queryClient.invalidateQueries({ queryKey: ['tags', id] });
  void queryClient.invalidateQueries({ queryKey: ['propkeys', id] });
  void queryClient.invalidateQueries({ queryKey: ['outline', id] });
}

/** Next free "Untitled", "Untitled 1", … inside dir. */
export function uniqueName(
  entries: readonly Pick<Entry, 'path'>[],
  dir: string,
  base: string,
  ext: string,
): string {
  const taken = new Set(entries.map((e) => e.path.toLowerCase()));
  const make = (n: number): string => `${dir ? dir + '/' : ''}${base}${n ? ' ' + n : ''}${ext}`;
  for (let n = 0; ; n++) if (!taken.has(make(n).toLowerCase())) return make(n);
}

/** Creates an empty note (in the configured folder unless dir is given) and opens it. */
export async function createNote(
  opts: { dir?: string; name?: string; open?: boolean; newTab?: boolean } = {},
): Promise<string> {
  const id = vaultId();
  const tree = await api.vault.listTree(id);
  const dir = (
    opts.dir ?? newNoteDir(useSettings.getState().editor, selectActivePath(useAppStore.getState()))
  ).replace(/^\/+|\/+$/g, '');
  const base = (opts.name ?? 'Untitled').replace(/\.md$/, '');
  const path = uniqueName(tree, dir, base, '.md');
  await api.vault.writeNote(id, path, await newNoteContent(id, path), '');
  invalidateVault(id);
  if (opts.open !== false)
    useAppStore.getState().openNote(path, { ...(opts.newTab ? { newTab: true } : {}) });
  return path;
}

/**
 * The content of a new note: the template chosen for new notes (Settings > Daily notes and
 * templates), expanded with the note's title, or nothing. A template that is gone or unreadable
 * leaves the note empty rather than failing its creation.
 */
async function newNoteContent(vaultId: string, path: string): Promise<string> {
  const ref = (await useNotesSettings.getState().ready(vaultId)).newNoteTemplate;
  if (!ref) return '';
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
  try {
    return await api.templates.expand(vaultId, ref, title, uiLang());
  } catch {
    return '';
  }
}

export async function createFolder(dir: string): Promise<void> {
  const id = vaultId();
  await api.vault.createFolder(id, dir);
  invalidateVault(id);
}

/** Asks for a name and creates a folder next to where a new note would go. */
export async function promptNewFolder(
  prompt: (title: string) => Promise<string | null>,
  title: string,
): Promise<void> {
  const name = (await prompt(title))?.trim();
  if (!name) return;
  const dir = newNoteDir(
    useSettings.getState().editor,
    selectActivePath(useAppStore.getState()),
  ).replace(/^\/+|\/+$/g, '');
  await createFolder((dir ? dir + '/' : '') + name);
}

/** Switches between the light and the dark theme (the stored value stops being "system"). */
export async function toggleTheme(): Promise<void> {
  const st = useAppStore.getState();
  const next: Theme =
    effectiveTheme((st.settings.theme || 'system') as Theme) === 'dark' ? 'light' : 'dark';
  const settings = { ...st.settings, theme: next };
  st.setSettings(settings);
  applyTheme(next);
  await api.settings.set(settings);
}

/**
 * Opens the vault at `path`, replacing the one that is open: pending edits and the workspace are
 * written first, and the previous vault is closed once the new one is open. Opening the vault that
 * is already open does nothing. Errors are shown in a dialog.
 */
export async function openVaultAt(path: string): Promise<void> {
  const prev = useAppStore.getState().vault;
  try {
    if (prev) {
      // Edits that could not be written anywhere keep the vault open (the user resolves them first).
      if (!(await settleNotes())) return;
      await saveWorkspaceNow(prev.id);
    }
    const info = await api.vault.open(path);
    if (prev && prev.id === info.id) return;
    if (prev) await api.vault.close(prev.id).catch(() => undefined);
    useAppStore.getState().setVault(info);
    await queryClient.invalidateQueries({ queryKey: queryKeys.recentVaults });
  } catch (e) {
    await dialog.error(e);
  }
}

/**
 * Locks a private vault (forgets its key on this device). The open documents are written first,
 * since the core pushes what waits for upload before forgetting the key and a host may drop the
 * clear-text copy once nothing is left to push; edits that cannot be saved go to a copy next to
 * their file, and edits that cannot be written anywhere keep the vault unlocked (D-04).
 * Resolves whether the vault was locked.
 */
export async function lockVault(id: string): Promise<boolean> {
  const report = await flushAllNotes();
  if (report.failed.length && !(await settleNotes())) return false;
  await api.crypto.lock(id);
  return true;
}

export interface RenameResult {
  notesUpdated: number;
  linksUpdated: number;
}

/** Renames/moves with link updates; `confirm` receives the plan and may veto it. */
export async function renameEntry(
  from: string,
  to: string,
  confirm?: (plan: { notes: number; links: number }) => boolean | Promise<boolean>,
): Promise<RenameResult | null> {
  const id = vaultId();
  // Pending edits go to disk first: the rename moves the files and rewrites links inside them,
  // and an open note must not keep (and later write) text from before that.
  const flushed = await flushAllNotes();
  const plan = await api.links.planRename(id, from, to);
  const touched = (p: string): boolean =>
    p === from || p.startsWith(from + '/') || plan.files.some((f) => f.path === p);
  const blocked = flushed.failed.filter(touched);
  if (blocked.length) {
    await dialog.alert(
      i18next.t('editor.notSavedTitle'),
      i18next.t('editor.renameBlocked', { paths: blocked.join(', ') }),
    );
    return null;
  }
  const notes = plan.files.length;
  const links = plan.files.reduce((n, f) => n + f.edits.length, 0);
  if (notes > 0 && confirm && !(await confirm({ notes, links }))) return null;
  await api.links.applyRename(id, from, to);
  useAppStore.getState().pathRenamed(from, to);
  useBookmarks.getState().pathRenamed(from, to);
  invalidateVault(id);
  return { notesUpdated: notes, linksUpdated: links };
}

/**
 * The path a rename gives to `path` once the user typed `input` in the prompt, or null when nothing
 * is to be done (an empty name, or the same one). The prompt shows the name without the extension of
 * a file the application opens (`splitName`) and the extension is put back: a rename never changes
 * it, so a drawing stays a drawing. An input that already ends with that extension (any case) is not
 * given a second one. Folders and files opened outside the application are renamed as typed.
 */
export function renameTarget(path: string, isDir: boolean, input: string): string | null {
  const name = input.trim();
  if (!name) return null;
  const slash = path.lastIndexOf('/');
  const current = path.slice(slash + 1);
  const { ext } = isDir ? { ext: '' } : splitName(current);
  const typed =
    ext && name.length > ext.length && name.toLowerCase().endsWith(ext.toLowerCase())
      ? name.slice(0, -ext.length)
      : name;
  const next = typed + ext;
  return next === current ? null : path.slice(0, slash + 1) + next;
}

/**
 * Asks for a new name for a file or a folder (the prefilled text is the name without the extension
 * the rename keeps) and renames it with the update of the links that point to it. Nothing happens
 * when the dialog is cancelled or the name is empty or unchanged. Errors are the caller's.
 */
export async function promptRename(entry: {
  path: string;
  isDir: boolean;
}): Promise<RenameResult | null> {
  const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
  const shown = entry.isDir ? name : splitName(name).stem;
  const input = await dialog.prompt(i18next.t('sidebar.promptRename'), shown);
  const to = input ? renameTarget(entry.path, entry.isDir, input) : null;
  if (!to) return null;
  return renameEntry(entry.path, to, ({ notes, links }) =>
    dialog.confirm(
      i18next.t('sidebar.rename'),
      i18next.t('sidebar.confirmLinkUpdate', { links, notes }),
    ),
  );
}

export async function deleteEntry(path: string): Promise<void> {
  const id = vaultId();
  await api.vault.trash(id, path);
  useAppStore.getState().pathRemoved(path);
  invalidateVault(id);
}

/** Opens the note a link points to (creating nothing); returns false when unresolved. */
export async function followLink(
  from: string,
  spec: { target: string; heading: string; block: string },
  newTab: boolean,
  split?: 'row' | 'column',
): Promise<boolean> {
  const id = vaultId();
  if (!spec.target && !spec.heading && !spec.block) return false;
  const path = spec.target ? await api.links.resolve(id, from, spec.target) : from;
  if (!path) return false;
  useAppStore.getState().openNote(path, {
    newTab,
    ...(split ? { split } : {}),
    ...(spec.heading ? { heading: spec.heading } : {}),
    ...(spec.block ? { block: spec.block } : {}),
  });
  return true;
}

/** A link to a note that does not exist yet creates it on click (as is customary). */
export async function openOrCreate(
  from: string,
  spec: { target: string; heading: string; block: string },
  newTab: boolean,
): Promise<void> {
  if (await followLink(from, spec, newTab)) return;
  if (!spec.target) return;
  // Next to the note the link is in; never next to a template open in a tab (folderOf).
  const dir = folderOf(from);
  try {
    await createNote({
      dir: useSettings.getState().editor.newNoteFolder || dir,
      name: spec.target.split('/').pop() ?? spec.target,
      newTab,
    });
  } catch (e) {
    if (errorCode(e) !== 'exists') throw e;
  }
}
