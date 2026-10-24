// What the user can do with bookmarks, shared by the sidebar panel, the
// command registry and the context menus.
import i18next from 'i18next';
import { api } from '../app/api';
import { getActiveEditor } from '../editor/registry';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import type { MenuItem } from '../ui/ContextMenu';
import { activeTab } from '../workspace/layout';
import { captureGraphOptions, openGraph } from './graphHook';
import { blockAtLine, headingAtLine, newBlockId } from './locate';
import {
  addItem,
  blockSubpath,
  fileItem,
  fileTarget,
  findExisting,
  flatten,
  folderItem,
  graphItem,
  groupItem,
  headingSubpath,
  itemLabel,
  pathKey,
  searchItem,
  type BookmarkItem,
  type ItemPath,
} from './model';
import { bookmarksReadOnly, useBookmarks } from './store';

const t = (key: string, opts: Record<string, unknown> = {}): string => i18next.t(key, opts);
const store = () => useAppStore.getState();

export const canEditBookmarks = (): boolean => {
  const v = store().vault;
  return !!v && !bookmarksReadOnly(v.id);
};

/** Shows the Bookmarks sidebar tab. */
export function showBookmarks(): void {
  store().setLeft({ open: true, tab: 'bookmarks' });
}

/** Adds an item unless the same target is already bookmarked; shows the list either way. */
export function addBookmark(item: BookmarkItem, parent: ItemPath = []): boolean {
  if (!canEditBookmarks()) return false;
  useBookmarks.getState().update((items) => {
    if (item.type !== 'graph' && findExisting(items, item)) return items;
    return addItem(items, item, parent);
  });
  showBookmarks();
  return true;
}

const activePath = (): string | null => activeTab(store().layout)?.path ?? null;

export function bookmarkNote(path: string | null = activePath()): void {
  if (path) addBookmark(fileItem(path));
}

export function bookmarkFolder(path: string): void {
  addBookmark(folderItem(path));
}

/** The 1-based cursor line and the text of the focused editor. */
function cursor(): { text: string; line: number } | null {
  const view = getActiveEditor();
  if (!view) return null;
  const head = view.state.selection.main.head;
  return { text: view.state.doc.toString(), line: view.state.doc.lineAt(head).number };
}

export const headingUnderCursor = (): string | null => {
  const c = cursor();
  return c ? (headingAtLine(c.text, c.line)?.text ?? null) : null;
};

export const hasBlockUnderCursor = (): boolean => {
  const c = cursor();
  return !!c && blockAtLine(c.text, c.line) !== null;
};

export function bookmarkHeading(): void {
  const path = activePath();
  const heading = headingUnderCursor();
  if (path && heading) addBookmark(fileItem(path, headingSubpath(heading)));
}

/** Bookmarks the block under the cursor, giving it a ^id first when it has none. */
export function bookmarkBlock(): void {
  const path = activePath();
  const view = getActiveEditor();
  const c = cursor();
  if (!path || !view || !c || !canEditBookmarks()) return;
  const block = blockAtLine(c.text, c.line);
  if (!block) return;
  let id = block.id;
  if (!id) {
    id = newBlockId();
    const line = view.state.doc.line(block.endLine);
    view.dispatch({ changes: { from: line.to, insert: ` ^${id}` } });
  }
  addBookmark(fileItem(path, blockSubpath(id)));
}

export async function bookmarkSearch(): Promise<void> {
  if (!canEditBookmarks()) return;
  const query = await dialog.prompt(t('bookmarks.searchPrompt'), store().searchQuery);
  if (query?.trim()) addBookmark(searchItem(query.trim()));
}

export async function bookmarkGraph(): Promise<void> {
  const options = captureGraphOptions();
  if (!options || !canEditBookmarks()) return;
  const title = await dialog.prompt(t('bookmarks.graphPrompt'), t('bookmarks.graphDefault'));
  if (title?.trim()) addBookmark(graphItem(title.trim(), options));
}

export async function newBookmarkGroup(parent: ItemPath = []): Promise<void> {
  if (!canEditBookmarks()) return;
  const name = await dialog.prompt(t('bookmarks.groupPrompt'));
  if (!name?.trim()) return;
  useBookmarks.getState().update((items) => addItem(items, groupItem(name.trim()), parent));
}

/** Opens what the bookmark points to. */
export async function activateBookmark(item: BookmarkItem, newTab = false): Promise<void> {
  const vault = store().vault;
  if (!vault) return;
  switch (item.type) {
    case 'file': {
      const target = fileTarget(item);
      const tree = await api.vault.listTree(vault.id);
      if (!tree.some((e) => e.path === target.path)) {
        await dialog.alert(
          t('bookmarks.missingTitle'),
          t('bookmarks.missing', { path: target.path }),
        );
        return;
      }
      store().openNote(target.path, {
        newTab,
        ...(target.heading ? { heading: target.heading } : {}),
        ...(target.block ? { block: target.block } : {}),
      });
      return;
    }
    case 'folder':
      store().setLeft({ open: true, tab: 'files' });
      return;
    case 'search':
      store().search(item.query ?? '');
      return;
    case 'graph':
      if (!openGraph(item.options ?? {}))
        await dialog.alert(t('bookmarks.graphMissingTitle'), t('bookmarks.graphMissing'));
      return;
    default:
      return;
  }
}

/** "Open bookmark…": a filterable list of every bookmark. */
export async function pickBookmark(): Promise<void> {
  const flat = flatten(useBookmarks.getState().file.items);
  if (flat.length === 0) {
    await dialog.alert(t('bookmarks.title'), t('bookmarks.empty'));
    return;
  }
  const key = await dialog.pick(
    t('bookmarks.open'),
    flat.map((f) => ({
      value: pathKey(f.path),
      label: (f.trail ? f.trail + ' / ' : '') + itemLabel(f.item),
    })),
  );
  const chosen = flat.find((f) => pathKey(f.path) === key);
  if (chosen) await activateBookmark(chosen.item);
}

/** Context-menu entry "Add to bookmarks" for a file or folder (none in a read-only vault). */
export function bookmarkMenuItems(path: string, isDir: boolean): MenuItem[] {
  if (!canEditBookmarks()) return [];
  return [
    {
      label: t('bookmarks.add'),
      onSelect: () => (isDir ? bookmarkFolder(path) : bookmarkNote(path)),
    },
  ];
}
