// vault:file-changed, coalesced and applied with care. The event fires after every watcher batch:
// for the app's own autosaves, for external edits and for each batch a sync applies. Reloading
// the whole file tree and every link resolution each time was the main cost of typing and syncing,
// so bursts are merged into one batch and each change only touches what it can affect:
// a content edit patches the tree entry and invalidates content-derived queries, while creations,
// deletions and renames patch the tree and re-resolve only the links they may redirect.
// (The editor's external-change check listens to the raw event, see useNoteDocument.)
import type { QueryClient } from '@tanstack/react-query';
import { api, type Entry } from './api';
import { Events, type FileChange, type FileChangedPayload } from './events';
import { queryKeys } from '../state/queries';
import { forgetMedia } from '../embeds/media';

/** A coalesced set of changes of one vault. */
export interface VaultChangeBatch {
  vaultId: string;
  /** The net change of each path (a creation followed by edits stays a creation). */
  changes: FileChange[];
  /** Some payload had no typed changes (older core): assume anything changed. */
  unknown: boolean;
  /** Every path the batch reported. */
  paths: string[];
}

/** Events closer than this are delivered as one batch. */
export const COALESCE_MS = 50;

type Listener = (batch: VaultChangeBatch) => void;

interface Pending {
  changes: Map<string, FileChange>;
  paths: Set<string>;
  unknown: boolean;
}

const listeners = new Set<Listener>();
const pending = new Map<string, Pending>();
let offRaw: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The change a path ends with when `next` follows `prev` within one batch. */
function merge(prev: FileChange | undefined, next: FileChange): FileChange {
  if (prev?.type === 'create' && next.type === 'modify') return { ...next, type: 'create' };
  return next;
}

function receive(p: FileChangedPayload): void {
  let acc = pending.get(p.vaultId);
  if (!acc) {
    acc = { changes: new Map(), paths: new Set(), unknown: false };
    pending.set(p.vaultId, acc);
  }
  for (const path of p.paths ?? []) acc.paths.add(path);
  if (!p.changes) acc.unknown = true;
  for (const c of p.changes ?? []) {
    if (c.type === 'rename' && c.from) {
      acc.paths.add(c.from);
      acc.changes.set(c.from, { type: 'delete', path: c.from });
      acc.changes.set(c.path, merge(acc.changes.get(c.path), { ...c, type: 'create' }));
      continue;
    }
    acc.paths.add(c.path);
    acc.changes.set(c.path, merge(acc.changes.get(c.path), c));
  }
  timer ??= setTimeout(flush, COALESCE_MS);
}

function flush(): void {
  timer = undefined;
  const batches = [...pending.entries()];
  pending.clear();
  for (const [vaultId, acc] of batches) {
    const batch: VaultChangeBatch = {
      vaultId,
      changes: [...acc.changes.values()],
      unknown: acc.unknown,
      paths: [...acc.paths],
    };
    for (const l of [...listeners]) {
      try {
        l(batch);
      } catch (e) {
        console.error('memobrain: file change listener failed', e);
      }
    }
  }
}

/**
 * Calls listener with coalesced batches of vault:file-changed. The backend event is listened to
 * only while someone is subscribed.
 */
export function onVaultChanges(listener: Listener): () => void {
  listeners.add(listener);
  offRaw ??= api.on(Events.vaultFileChanged, receive);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    offRaw?.();
    offRaw = null;
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
  };
}

const TEXTUAL = /\.(md|canvas|excalidraw)$/i;
const isNote = (path: string): boolean => /\.md$/i.test(path);
/** Device and vault settings: never content of the index views. */
const isConfig = (path: string): boolean => path === '.memobrain' || path.startsWith('.memobrain/');
const under = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + '/');

/**
 * Patches the cached file tree. Returns false when the cache cannot be patched reliably (a new
 * folder, whose contents may not be listed, or a file whose folder is unknown).
 */
function patchTree(entries: readonly Entry[], changes: readonly FileChange[]): Entry[] | false {
  let out: Entry[] | null = null;
  // Deletions first, in one pass (a path has one net change per batch, so order does not matter;
  // a file created inside a folder deleted in the same batch finds no parent and reloads the tree).
  const gone = new Set(changes.filter((c) => c.type === 'delete').map((c) => c.path));
  if (gone.size > 0) {
    const removed = (path: string): boolean => {
      for (let p = path; ; p = p.slice(0, p.lastIndexOf('/'))) {
        if (gone.has(p)) return true;
        if (!p.includes('/')) return false;
      }
    };
    const kept = entries.filter((e) => !removed(e.path));
    if (kept.length !== entries.length) out = kept;
  }
  const base: readonly Entry[] = out ?? entries;
  const index = new Map(base.map((e, i) => [e.path, i]));
  const edit = (): Entry[] => (out ??= [...entries]);
  for (const c of changes) {
    const e = c.type === 'delete' ? undefined : c.entry;
    if (!e) continue;
    const at = index.get(e.path);
    if (e.isDir) {
      if (at === undefined) return false;
      continue;
    }
    if (at !== undefined) {
      const old = base[at];
      if (old && old.size === e.size && String(old.mtime) === String(e.mtime)) continue;
      edit()[at] = e;
      continue;
    }
    const slash = e.path.lastIndexOf('/');
    if (slash > 0 && !index.has(e.path.slice(0, slash))) return false;
    // Appended: parents come before their children, which is all buildTree needs.
    index.set(e.path, edit().push(e) - 1);
  }
  return out ?? (entries as Entry[]);
}

/** Applies a batch to the query cache: tree patch, content invalidations. */
export function applyVaultChanges(qc: QueryClient, batch: VaultChangeBatch): void {
  const id = batch.vaultId;
  const invalidate = (queryKey: readonly unknown[]): void =>
    void qc.invalidateQueries({ queryKey });
  forgetMedia(id, batch.paths);
  if (batch.unknown) {
    for (const k of ['tree', 'search', 'backlinks', 'tags', 'propkeys', 'outline'])
      invalidate([k, id]);
    return;
  }

  const treeKey = queryKeys.tree(id);
  const tree = qc.getQueryState<Entry[]>(treeKey);
  if (tree?.data !== undefined) {
    const patched = tree.fetchStatus === 'fetching' ? false : patchTree(tree.data, batch.changes);
    if (patched === false) invalidate(treeKey);
    else if (patched !== tree.data) qc.setQueryData(treeKey, patched);
  }

  const relevant = batch.changes.filter((c) => !isConfig(c.path));
  const structural = relevant.some((c) => c.type !== 'modify');
  const textEdits = relevant.filter((c) => c.type === 'modify' && TEXTUAL.test(c.path));
  if (structural || textEdits.length > 0) {
    invalidate(['search', id]);
    invalidate(['backlinks', id]);
  }
  if (structural || textEdits.some((c) => isNote(c.path))) {
    invalidate(queryKeys.tags(id));
    invalidate(queryKeys.propkeys(id));
  }
  for (const c of relevant) if (isNote(c.path)) invalidate(queryKeys.outline(id, c.path));
}

const stemOf = (s: string): string =>
  (s.split('/').pop() ?? s).replace(/\.md$/i, '').trim().toLowerCase();

/**
 * Link targets whose resolution a batch may change, given what each target resolved to ('' when
 * unresolved). null means "any of them" (a new folder, or an untyped batch).
 *
 * - deleting P: the targets that pointed at P (or inside it);
 * - creating P: the unresolved targets, and those named like P (a closer file may now win);
 * - editing note P: the unresolved targets and those pointing at P (its aliases may have changed).
 */
export function staleTargets(
  resolved: ReadonlyMap<string, string>,
  batch: VaultChangeBatch,
): string[] | null {
  if (batch.unknown) return null;
  const out = new Set<string>();
  for (const c of batch.changes) {
    if (c.type === 'delete') {
      for (const [t, p] of resolved) if (p && under(p, c.path)) out.add(t);
    } else if (c.type === 'create') {
      if (c.entry?.isDir) return null;
      const stem = stemOf(c.path);
      for (const [t, p] of resolved) if (p === '' || stemOf(t) === stem) out.add(t);
    } else if (isNote(c.path)) {
      for (const [t, p] of resolved) if (p === '' || p === c.path) out.add(t);
    }
  }
  return [...out];
}
