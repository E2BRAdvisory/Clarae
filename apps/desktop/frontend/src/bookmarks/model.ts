// Bookmarks model (§2.2.1 "Bookmarks"): a tree of items stored in
// .nodus/bookmarks.json. Everything here is pure: functions take the item list
// and return a new one, so tree operations are easy to test and to persist.
//
// File shape (compatible in spirit with Obsidian's bookmarks.json; unknown
// fields and unknown item types are preserved on save):
//
//   { "version": 1,
//     "items": [
//       { "type": "file",   "path": "A.md", "subpath": "#Heading" | "#^block-id", "title": "", "ctime": 0 },
//       { "type": "folder", "path": "Projects", "title": "" },
//       { "type": "search", "query": "tag:#todo", "title": "Open tasks" },
//       { "type": "graph",  "title": "Overview", "options": { ... opaque ... } },
//       { "type": "group",  "title": "Reading", "items": [ ... ] } ] }
//
// Items are addressed by their index path in the tree ([2, 0] = first child of
// the third root item); the file carries no ids.

export interface BookmarkItem {
  type: string;
  title?: string;
  ctime?: number;
  path?: string;
  subpath?: string;
  query?: string;
  options?: Record<string, unknown>;
  items?: BookmarkItem[];
  [key: string]: unknown;
}

export interface BookmarksFile {
  version: number;
  items: BookmarkItem[];
  /** Unknown top-level fields, written back as they were. */
  extra: Record<string, unknown>;
}

export const BOOKMARKS_VERSION = 1;
const MAX_DEPTH = 16;

export type ItemPath = readonly number[];

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function parseItem(raw: unknown, depth: number): BookmarkItem | null {
  if (!isObject(raw) || typeof raw['type'] !== 'string' || depth > MAX_DEPTH) return null;
  const item = { ...raw } as BookmarkItem;
  switch (item.type) {
    case 'file':
    case 'folder':
      if (typeof item.path !== 'string' || item.path === '') return null;
      if (item.subpath !== undefined && typeof item.subpath !== 'string') delete item.subpath;
      break;
    case 'search':
      if (typeof item.query !== 'string') return null;
      break;
    case 'graph':
      if (!isObject(item.options)) item.options = {};
      break;
    case 'group': {
      const children = Array.isArray(raw['items']) ? raw['items'] : [];
      item.items = children
        .map((c) => parseItem(c, depth + 1))
        .filter((c): c is BookmarkItem => c !== null);
      if (typeof item.title !== 'string') item.title = '';
      break;
    }
    default:
      break; // unknown type from a newer version: kept untouched
  }
  if (item.title !== undefined && typeof item.title !== 'string') delete item.title;
  if (item.ctime !== undefined && typeof item.ctime !== 'number') delete item.ctime;
  return item;
}

export function emptyBookmarks(): BookmarksFile {
  return { version: BOOKMARKS_VERSION, items: [], extra: {} };
}

/** Parses the file text; anything malformed yields an empty list (never throws). */
export function parseBookmarks(text: string): BookmarksFile {
  if (!text.trim()) return emptyBookmarks();
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw)) return emptyBookmarks();
    const { version, items, ...extra } = raw;
    return {
      version: typeof version === 'number' ? version : BOOKMARKS_VERSION,
      items: (Array.isArray(items) ? items : [])
        .map((i) => parseItem(i, 0))
        .filter((i): i is BookmarkItem => i !== null),
      extra,
    };
  } catch {
    return emptyBookmarks();
  }
}

export function serializeBookmarks(file: BookmarksFile): string {
  return JSON.stringify(
    { ...file.extra, version: Math.max(file.version, BOOKMARKS_VERSION), items: file.items },
    null,
    2,
  );
}

// ---- constructors ----------------------------------------------------------

export function fileItem(path: string, subpath = '', now = Date.now()): BookmarkItem {
  return { type: 'file', path, ...(subpath ? { subpath } : {}), ctime: now };
}
export const headingSubpath = (heading: string): string => '#' + heading;
export const blockSubpath = (id: string): string => '#^' + id;
export function folderItem(path: string, now = Date.now()): BookmarkItem {
  return { type: 'folder', path, ctime: now };
}
export function searchItem(query: string, title = '', now = Date.now()): BookmarkItem {
  return { type: 'search', query, ...(title ? { title } : {}), ctime: now };
}
export function graphItem(
  title: string,
  options: Record<string, unknown>,
  now = Date.now(),
): BookmarkItem {
  return { type: 'graph', title, options, ctime: now };
}
export function groupItem(title: string, now = Date.now()): BookmarkItem {
  return { type: 'group', title, items: [], ctime: now };
}

// ---- reading an item -------------------------------------------------------

/** The note, heading and block a "file" item points to. */
export function fileTarget(item: BookmarkItem): { path: string; heading: string; block: string } {
  const sub = item.subpath ?? '';
  return {
    path: item.path ?? '',
    heading: sub.startsWith('#') && !sub.startsWith('#^') ? sub.slice(1) : '',
    block: sub.startsWith('#^') ? sub.slice(2) : '',
  };
}

const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/, '');

/** What the sidebar shows: the user's title, or one derived from the target. */
export function itemLabel(item: BookmarkItem): string {
  if (item.title) return item.title;
  switch (item.type) {
    case 'file': {
      const t = fileTarget(item);
      return baseName(t.path) + (t.heading ? ` > ${t.heading}` : t.block ? ` > ^${t.block}` : '');
    }
    case 'folder':
      return item.path ?? '';
    case 'search':
      return item.query ?? '';
    case 'graph':
      return 'Graph';
    default:
      return item.type;
  }
}

export const isGroup = (item: BookmarkItem): boolean => item.type === 'group';

// ---- tree operations -------------------------------------------------------

export function getItem(items: BookmarkItem[], path: ItemPath): BookmarkItem | null {
  let list = items;
  let cur: BookmarkItem | undefined;
  for (const i of path) {
    cur = list[i];
    if (!cur) return null;
    list = cur.items ?? [];
  }
  return cur ?? null;
}

function listAt(items: BookmarkItem[], parent: ItemPath): BookmarkItem[] | null {
  if (parent.length === 0) return items;
  const g = getItem(items, parent);
  return g && isGroup(g) ? (g.items ?? []) : null;
}

function withList(
  items: BookmarkItem[],
  parent: ItemPath,
  fn: (list: BookmarkItem[]) => BookmarkItem[],
): BookmarkItem[] {
  if (parent.length === 0) return fn(items);
  const [head, ...rest] = parent;
  return items.map((it, i) =>
    i === head ? { ...it, items: withList(it.items ?? [], rest, fn) } : it,
  );
}

/** Inserts item into the group at `parent` ([] = root) at `index` (default: end). */
export function addItem(
  items: BookmarkItem[],
  item: BookmarkItem,
  parent: ItemPath = [],
  index?: number,
): BookmarkItem[] {
  if (!listAt(items, parent)) return items;
  return withList(items, parent, (list) => {
    const at = Math.min(Math.max(0, index ?? list.length), list.length);
    return [...list.slice(0, at), item, ...list.slice(at)];
  });
}

export function removeItem(items: BookmarkItem[], path: ItemPath): BookmarkItem[] {
  if (!getItem(items, path)) return items;
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1] as number;
  return withList(items, parent, (list) => list.filter((_, i) => i !== idx));
}

export function updateItem(
  items: BookmarkItem[],
  path: ItemPath,
  patch: Partial<BookmarkItem>,
): BookmarkItem[] {
  if (!getItem(items, path)) return items;
  const parent = path.slice(0, -1);
  const idx = path[path.length - 1] as number;
  return withList(items, parent, (list) =>
    list.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
  );
}

/** Sets or clears (empty) the user's title; a group always keeps a name. */
export function renameItem(items: BookmarkItem[], path: ItemPath, title: string): BookmarkItem[] {
  const it = getItem(items, path);
  if (!it) return items;
  if (title.trim() === '') {
    if (isGroup(it)) return items;
    const rest = { ...it };
    delete rest.title;
    const idx = path[path.length - 1];
    return withList(items, path.slice(0, -1), (list) => list.map((x, i) => (i === idx ? rest : x)));
  }
  return updateItem(items, path, { title: title.trim() });
}

const startsWith = (path: ItemPath, prefix: ItemPath): boolean =>
  prefix.length <= path.length && prefix.every((v, i) => path[i] === v);

/**
 * Moves the item at `from` into the group `toParent` ([] = root) before `toIndex`
 * (an index in the destination list as it is before the move). A group cannot be
 * moved into itself or one of its descendants (no-op).
 */
export function moveItem(
  items: BookmarkItem[],
  from: ItemPath,
  toParent: ItemPath,
  toIndex?: number,
): BookmarkItem[] {
  const item = getItem(items, from);
  const dest = listAt(items, toParent);
  if (!item || !dest || startsWith(toParent, from)) return items;
  const fromParent = from.slice(0, -1);
  const fromIdx = from[from.length - 1] as number;
  let parent = [...toParent];
  let index = toIndex ?? dest.length;
  const sameParent =
    fromParent.length === toParent.length && fromParent.every((v, i) => v === toParent[i]);
  if (sameParent && fromIdx < index) index -= 1;
  // Removing the item shifts later siblings in an ancestor list of the destination.
  if (
    !sameParent &&
    startsWith(toParent, fromParent) &&
    toParent.length > fromParent.length &&
    (toParent[fromParent.length] as number) > fromIdx
  ) {
    parent = parent.map((v, i) => (i === fromParent.length ? v - 1 : v));
  }
  return addItem(removeItem(items, from), item, parent, index);
}

/** Item targets are the same bookmark (used to avoid adding duplicates). */
export function sameTarget(a: BookmarkItem, b: BookmarkItem): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'file':
      return a.path === b.path && (a.subpath ?? '') === (b.subpath ?? '');
    case 'folder':
      return a.path === b.path;
    case 'search':
      return a.query === b.query;
    default:
      return false;
  }
}

/** Path of the first item with the same target, or null. */
export function findExisting(items: BookmarkItem[], candidate: BookmarkItem): ItemPath | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as BookmarkItem;
    if (isGroup(it)) {
      const inner = findExisting(it.items ?? [], candidate);
      if (inner) return [i, ...inner];
    } else if (sameTarget(it, candidate)) return [i];
  }
  return null;
}

/** A file or folder was renamed/moved: bookmarks follow it. */
export function renamePaths(items: BookmarkItem[], from: string, to: string): BookmarkItem[] {
  let changed = false;
  const walk = (list: BookmarkItem[]): BookmarkItem[] =>
    list.map((it) => {
      if (isGroup(it)) {
        const inner = walk(it.items ?? []);
        return inner === it.items ? it : { ...it, items: inner };
      }
      if ((it.type === 'file' || it.type === 'folder') && typeof it.path === 'string') {
        if (it.path === from || it.path.startsWith(from + '/')) {
          changed = true;
          return { ...it, path: to + it.path.slice(from.length) };
        }
      }
      return it;
    });
  const next = walk(items);
  return changed ? next : items;
}

export interface FlatBookmark {
  path: ItemPath;
  item: BookmarkItem;
  /** Names of the enclosing groups, "A / B". */
  trail: string;
}

/** Every non-group item in tree order (for pickers). */
export function flatten(items: BookmarkItem[], trail = '', prefix: ItemPath = []): FlatBookmark[] {
  return items.flatMap((item, i) => {
    const path = [...prefix, i];
    return isGroup(item)
      ? flatten(
          item.items ?? [],
          trail ? `${trail} / ${item.title ?? ''}` : (item.title ?? ''),
          path,
        )
      : [{ path, item, trail }];
  });
}

/** Every group with its index path and depth (for "move to group"). */
export function groupsOf(
  items: BookmarkItem[],
  prefix: ItemPath = [],
): { path: ItemPath; title: string; depth: number }[] {
  return items.flatMap((item, i) => {
    if (!isGroup(item)) return [];
    const path = [...prefix, i];
    return [
      { path, title: item.title ?? '', depth: path.length - 1 },
      ...groupsOf(item.items ?? [], path),
    ];
  });
}

export const pathKey = (p: ItemPath): string => p.join('.');
