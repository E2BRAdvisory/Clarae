// Bookmarks state for the open vault. Loaded and reset automatically when the
// vault changes; persisted (debounced) to .nodus/bookmarks.json, which is
// synchronized user data (it is not excluded by shared/go/pathrules); an
// external change of the file (another device through sync, a text editor)
// reloads the list.
import { create } from 'zustand';
import { api } from '../app/api';
import { Events, type FileChangedPayload } from '../app/events';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import {
  emptyBookmarks,
  parseBookmarks,
  renamePaths,
  serializeBookmarks,
  type BookmarkItem,
  type BookmarksFile,
} from './model';

export const BOOKMARKS_FILE = 'bookmarks.json';
const FILE_PATH = '.nodus/' + BOOKMARKS_FILE;
const SAVE_DELAY_MS = 300;

interface BookmarksState {
  vaultId: string | null;
  file: BookmarksFile;
  loaded: boolean;
  load: (vaultId: string) => Promise<void>;
  reset: () => void;
  /** Applies a change to the item list and saves it; false when the vault is read-only. */
  update: (fn: (items: BookmarkItem[]) => BookmarkItem[]) => boolean;
  /** A file or folder was renamed: bookmarks follow it. */
  pathRenamed: (from: string, to: string) => void;
  /** Writes pending changes now. */
  flush: () => Promise<void>;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending = false;
let lastWritten = '';
let off: (() => void) | null = null;

/** Bookmarks of a read-only vault (viewer mount) are shown but cannot be edited. */
export function bookmarksReadOnly(vaultId: string | null): boolean {
  return !vaultId || infoOf(useSync.getState(), vaultId).readOnly;
}

export const useBookmarks = create<BookmarksState>((set, get) => {
  const write = async (): Promise<void> => {
    clearTimeout(timer);
    const { vaultId, file } = get();
    if (!pending || !vaultId) return;
    pending = false;
    const text = serializeBookmarks(file);
    lastWritten = text;
    try {
      await api.vault.writeConfig(vaultId, BOOKMARKS_FILE, text);
    } catch {
      /* the next change retries; the in-memory list stays authoritative */
    }
  };

  return {
    vaultId: null,
    file: emptyBookmarks(),
    loaded: false,

    async load(vaultId) {
      off?.();
      off = api.on<FileChangedPayload>(Events.vaultFileChanged, (p) => {
        if (p.vaultId !== get().vaultId || !p.paths.includes(FILE_PATH) || pending) return;
        void api.vault
          .readConfig(p.vaultId, BOOKMARKS_FILE)
          .then((text) => {
            if (text === lastWritten || get().vaultId !== p.vaultId) return;
            lastWritten = text;
            set({ file: parseBookmarks(text) });
          })
          .catch(() => undefined);
      });
      set({ vaultId, file: emptyBookmarks(), loaded: false });
      pending = false;
      try {
        const text = await api.vault.readConfig(vaultId, BOOKMARKS_FILE);
        if (get().vaultId !== vaultId) return;
        lastWritten = text;
        set({ file: parseBookmarks(text), loaded: true });
      } catch {
        if (get().vaultId === vaultId) set({ loaded: true });
      }
    },

    reset() {
      off?.();
      off = null;
      clearTimeout(timer);
      pending = false;
      lastWritten = '';
      set({ vaultId: null, file: emptyBookmarks(), loaded: false });
    },

    update(fn) {
      const { vaultId, file } = get();
      if (!vaultId || bookmarksReadOnly(vaultId)) return false;
      const items = fn(file.items);
      if (items === file.items) return true;
      set({ file: { ...file, items } });
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(() => void write(), SAVE_DELAY_MS);
      return true;
    },

    pathRenamed(from, to) {
      const { vaultId, file } = get();
      if (!vaultId) return;
      const items = renamePaths(file.items, from, to);
      if (items === file.items) return;
      // A rename already happened on disk: keep the bookmarks even in a vault we cannot write.
      set({ file: { ...file, items } });
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(() => void write(), SAVE_DELAY_MS);
    },

    flush: write,
  };
});

// The list follows the open vault.
useAppStore.subscribe((s, prev) => {
  if (s.vault?.id === prev.vault?.id) return;
  void useBookmarks.getState().flush(); // changes still waiting belong to the vault being left
  if (s.vault) void useBookmarks.getState().load(s.vault.id);
  else useBookmarks.getState().reset();
});
