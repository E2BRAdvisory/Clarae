// High-level operations used by both the UI and the command registry.
import { api, errorCode, type Entry } from './api';
import { queryClient } from '../state/queryClient';
import { queryKeys } from '../state/queries';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';

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
  const dir = (opts.dir ?? useSettings.getState().editor.newNoteFolder).replace(/^\/+|\/+$/g, '');
  const base = (opts.name ?? 'Untitled').replace(/\.md$/, '');
  const path = uniqueName(tree, dir, base, '.md');
  await api.vault.writeNote(id, path, '', '');
  invalidateVault(id);
  if (opts.open !== false)
    useAppStore.getState().openNote(path, { ...(opts.newTab ? { newTab: true } : {}) });
  return path;
}

export async function createFolder(dir: string): Promise<void> {
  const id = vaultId();
  await api.vault.createFolder(id, dir);
  invalidateVault(id);
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
  const plan = await api.links.planRename(id, from, to);
  const notes = plan.files.length;
  const links = plan.files.reduce((n, f) => n + f.edits.length, 0);
  if (notes > 0 && confirm && !(await confirm({ notes, links }))) return null;
  await api.links.applyRename(id, from, to);
  useAppStore.getState().pathRenamed(from, to);
  invalidateVault(id);
  return { notesUpdated: notes, linksUpdated: links };
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

/** A link to a note that does not exist yet creates it on click (like Obsidian). */
export async function openOrCreate(
  from: string,
  spec: { target: string; heading: string; block: string },
  newTab: boolean,
): Promise<void> {
  if (await followLink(from, spec, newTab)) return;
  if (!spec.target) return;
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
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
