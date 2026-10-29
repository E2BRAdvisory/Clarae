// Bookmark commands; spread into the registry (commands/registry.ts).
import type { Command } from '../commands/registry';
import { useAppStore } from '../state/store';
import { activeTab } from '../workspace/layout';
import { dialog } from '../ui/dialogs';
import { getActiveEditor } from '../editor/registry';
import {
  bookmarkBlock,
  bookmarkGraph,
  bookmarkHeading,
  bookmarkNote,
  bookmarkSearch,
  canEditBookmarks,
  hasBlockUnderCursor,
  headingUnderCursor,
  newBookmarkGroup,
  pickBookmark,
  showBookmarks,
} from './actions';
import { hasGraphBookmarks } from './graphHook';

const store = () => useAppStore.getState();
const hasVault = (): boolean => store().vault !== null;
const hasNote = (): boolean => activeTab(store().layout) !== null;
const inEditor = (): boolean => getActiveEditor() !== null && hasNote();

async function guard(p: Promise<unknown> | void): Promise<void> {
  try {
    await p;
  } catch (e) {
    await dialog.error(e);
  }
}

export const bookmarkCommands: Command[] = [
  {
    id: 'bookmark:note',
    group: 'navigate',
    defaults: [],
    enabled: () => hasNote() && canEditBookmarks(),
    run: () => bookmarkNote(),
  },
  {
    id: 'bookmark:heading',
    group: 'navigate',
    defaults: [],
    enabled: () => inEditor() && canEditBookmarks() && headingUnderCursor() !== null,
    run: () => bookmarkHeading(),
  },
  {
    id: 'bookmark:block',
    group: 'navigate',
    defaults: [],
    enabled: () => inEditor() && canEditBookmarks() && hasBlockUnderCursor(),
    run: () => bookmarkBlock(),
  },
  {
    id: 'bookmark:search',
    group: 'navigate',
    defaults: [],
    enabled: () => hasVault() && canEditBookmarks(),
    run: () => guard(bookmarkSearch()),
  },
  {
    id: 'bookmark:graph',
    group: 'navigate',
    defaults: [],
    enabled: () => hasVault() && canEditBookmarks() && hasGraphBookmarks(),
    run: () => guard(bookmarkGraph()),
  },
  {
    id: 'bookmark:new-group',
    group: 'navigate',
    defaults: [],
    enabled: () => hasVault() && canEditBookmarks(),
    run: () => guard(newBookmarkGroup()),
  },
  {
    id: 'bookmark:open',
    group: 'navigate',
    defaults: [],
    enabled: hasVault,
    run: () => guard(pickBookmark()),
  },
  {
    id: 'sidebar:bookmarks',
    group: 'view',
    defaults: [],
    enabled: hasVault,
    run: showBookmarks,
  },
];
