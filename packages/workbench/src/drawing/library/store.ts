// The shape library of a vault (.clarae/excalidraw-library.json), held once for every drawing
// editor open on it. An editor that changes it tells the store, which writes the file after a
// pause; the other editors, and this one when the file changes from outside (the sync, another
// device), take the library from here. Nothing in this module imports Excalidraw.
import { create } from 'zustand';
import { api } from '../../app/api';

export const LIBRARY_FILE = 'excalidraw-library.json';
/** How long after the last change the library is written. */
export const LIBRARY_WRITE_MS = 800;

export type LibraryItem = Record<string, unknown>;

/**
 * What tells two libraries apart: the shapes, their order, name and status, and the versions of
 * their elements. Not the whole text: Excalidraw hands a library back with fields filled in, and
 * that alone is not a change worth writing.
 */
export function libraryKey(items: readonly LibraryItem[]): string {
  const text = (v: unknown): string =>
    typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  let key = '';
  for (const item of items) {
    const elements = Array.isArray(item['elements']) ? (item['elements'] as LibraryItem[]) : [];
    key += `${text(item['id'])}|${text(item['status'])}|${text(item['name'])}|`;
    for (const e of elements) key += `${text(e['id'])}:${text(e['version'])},`;
    key += ';';
  }
  return key;
}

/** The items of a library file's text; an empty, missing or unreadable file is an empty library. */
export function parseLibrary(text: string): LibraryItem[] {
  try {
    const items = (JSON.parse(text || '{}') as { libraryItems?: unknown }).libraryItems;
    return Array.isArray(items) ? (items as LibraryItem[]) : [];
  } catch {
    return [];
  }
}

export const serializeLibrary = (items: readonly LibraryItem[]): string =>
  JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: items });

interface LibraryState {
  /** The vault the library is of ('' before the first load). */
  vaultId: string;
  /** False until the file of `vaultId` has been read. */
  loaded: boolean;
  items: LibraryItem[];
  /** libraryKey(items): the editors compare it with what they show. */
  key: string;
  /**
   * Reads the library of a vault. A change made here and not written yet is kept: the file is
   * read again after the write.
   */
  load(vaultId: string): Promise<void>;
  /**
   * An editor changed the library. False when it is the library already held (Excalidraw reports
   * the library it was just given): nothing is written then.
   */
  changed(vaultId: string, items: readonly LibraryItem[]): boolean;
  /** Writes now what is waiting (a drawing closes, the vault closes, the app quits). */
  flush(): Promise<void>;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { vaultId: string; body: string } | null = null;

export const useDrawingLibrary = create<LibraryState>((set, get) => ({
  vaultId: '',
  loaded: false,
  items: [],
  key: '',
  async load(vaultId) {
    if (get().vaultId !== vaultId) {
      await get().flush(); // what was waiting belongs to the vault being left
      set({ vaultId, loaded: false, items: [], key: '' });
    }
    if (pending) return;
    // no library yet: an empty one
    const text = await api.vault.readConfig(vaultId, LIBRARY_FILE).catch(() => '');
    // The vault changed, or the library was changed here, while reading: this text is stale.
    if (get().vaultId !== vaultId || pending) return;
    const items = parseLibrary(text);
    const key = libraryKey(items);
    if (get().loaded && get().key === key) return;
    set({ loaded: true, items, key });
  },
  changed(vaultId, items) {
    const key = libraryKey(items);
    const cur = get();
    if (cur.vaultId === vaultId && cur.key === key) return false;
    set({ vaultId, loaded: true, items: [...items], key });
    pending = { vaultId, body: serializeLibrary(items) };
    clearTimeout(timer);
    timer = setTimeout(() => void get().flush(), LIBRARY_WRITE_MS);
    return true;
  },
  async flush() {
    clearTimeout(timer);
    const write = pending;
    pending = null;
    if (!write) return;
    try {
      await api.vault.writeConfig(write.vaultId, LIBRARY_FILE, write.body);
    } catch {
      // A vault that may not be changed keeps the library for the session only.
    }
  },
}));

/** Whether a changed path of the vault is its library file (under the current or the 1.x folder). */
export const isLibraryPath = (path: string): boolean =>
  path === LIBRARY_FILE || path.endsWith(`/${LIBRARY_FILE}`);
