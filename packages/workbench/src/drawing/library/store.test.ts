import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { installWailsMock, type WailsMock } from '../../test/wails-mock';
import {
  isLibraryPath,
  LIBRARY_WRITE_MS,
  libraryKey,
  parseLibrary,
  serializeLibrary,
  useDrawingLibrary,
  type LibraryItem,
} from './store';

const item = (id: string, version = 1, extra: LibraryItem = {}): LibraryItem => ({
  id,
  status: 'unpublished',
  created: 1,
  elements: [{ id: `${id}-el`, version }],
  ...extra,
});

let mock: WailsMock;
let vaultId = '';
const store = () => useDrawingLibrary.getState();
const onDisk = (id = vaultId): LibraryItem[] =>
  parseLibrary(mock.vaults.get(id)?.files.get('.clarae/excalidraw-library.json') ?? '');
const put = (items: LibraryItem[], id = vaultId) =>
  mock.vaults.get(id)?.files.set('.clarae/excalidraw-library.json', serializeLibrary(items));
const ids = (items: readonly LibraryItem[]) => items.map((i) => i['id']);

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mock = installWailsMock();
  vaultId = (await api.vault.open('/vaults/Library')).id;
  await store().flush();
  useDrawingLibrary.setState({ vaultId: '', loaded: false, items: [], key: '' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the shape library of a vault', () => {
  it('is read from the vault, an absent or broken file being an empty library', async () => {
    await store().load(vaultId);
    expect(store().loaded).toBe(true);
    expect(store().items).toEqual([]);

    put([item('a'), item('b')]);
    await store().load(vaultId);
    expect(ids(store().items)).toEqual(['a', 'b']);

    mock.vaults.get(vaultId)?.files.set('.clarae/excalidraw-library.json', '{not json');
    await store().load(vaultId);
    expect(store().items).toEqual([]);
    expect(parseLibrary('{"libraryItems":"no"}')).toEqual([]);
  });

  it('is not written when an editor hands back the library it was given', async () => {
    put([item('a')]);
    await store().load(vaultId);
    const write = vi.spyOn(api.vault, 'writeConfig');
    // Excalidraw returns the same shapes, with fields of its own filled in
    expect(store().changed(vaultId, [item('a', 1, { filled: 'in' })])).toBe(false);
    await vi.advanceTimersByTimeAsync(LIBRARY_WRITE_MS * 2);
    expect(write).not.toHaveBeenCalled();
  });

  it('is written a moment after an editor changed it, once for a burst of changes', async () => {
    await store().load(vaultId);
    const write = vi.spyOn(api.vault, 'writeConfig');
    expect(store().changed(vaultId, [item('a')])).toBe(true);
    await vi.advanceTimersByTimeAsync(LIBRARY_WRITE_MS - 1);
    expect(store().changed(vaultId, [item('a'), item('b')])).toBe(true);
    await vi.advanceTimersByTimeAsync(LIBRARY_WRITE_MS - 1);
    expect(write).not.toHaveBeenCalled();
    // the other editors see it at once, before the file is written
    expect(ids(store().items)).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(ids(onDisk())).toEqual(['a', 'b']);
  });

  it('is written at once when asked (a drawing closes)', async () => {
    await store().load(vaultId);
    store().changed(vaultId, [item('a')]);
    await store().flush();
    expect(ids(onDisk())).toEqual(['a']);
    // nothing waiting any more
    const write = vi.spyOn(api.vault, 'writeConfig');
    await vi.advanceTimersByTimeAsync(LIBRARY_WRITE_MS * 2);
    await store().flush();
    expect(write).not.toHaveBeenCalled();
  });

  it('follows the file when it changes from outside', async () => {
    put([item('a')]);
    await store().load(vaultId);
    const before = store().items;
    await store().load(vaultId); // nothing new: the editors are not told
    expect(store().items).toBe(before);

    put([item('a'), item('theirs')]); // the sync, another device
    await store().load(vaultId);
    expect(ids(store().items)).toEqual(['a', 'theirs']);
  });

  it('keeps a change made here over a file read meanwhile', async () => {
    put([item('a')]);
    await store().load(vaultId);
    store().changed(vaultId, [item('a'), item('mine')]);
    put([item('a'), item('theirs')]);
    await store().load(vaultId); // not yet written: the file is not taken
    expect(ids(store().items)).toEqual(['a', 'mine']);
    await store().flush();
    expect(ids(onDisk())).toEqual(['a', 'mine']);
  });

  it('survives a vault that may not be changed', async () => {
    await store().load(vaultId);
    vi.spyOn(api.vault, 'writeConfig').mockRejectedValue(new Error('read-only'));
    store().changed(vaultId, [item('a')]);
    await expect(store().flush()).resolves.toBeUndefined();
    expect(ids(store().items)).toEqual(['a']); // kept for the session
  });

  it('writes what was waiting before moving to another vault', async () => {
    await store().load(vaultId);
    store().changed(vaultId, [item('a')]);
    const other = (await api.vault.open('/vaults/Other')).id;
    put([item('z')], other);
    await store().load(other);
    expect(ids(onDisk(vaultId))).toEqual(['a']);
    expect(ids(store().items)).toEqual(['z']);
  });

  it('tells libraries apart by shapes, order, name, status and element versions', () => {
    const base = libraryKey([item('a'), item('b')]);
    expect(libraryKey([item('a'), item('b')])).toBe(base);
    expect(libraryKey([item('b'), item('a')])).not.toBe(base);
    expect(libraryKey([item('a')])).not.toBe(base);
    expect(libraryKey([item('a', 2), item('b')])).not.toBe(base);
    expect(libraryKey([item('a', 1, { name: 'Arrow' }), item('b')])).not.toBe(base);
    expect(libraryKey([item('a', 1, { status: 'published' }), item('b')])).not.toBe(base);
  });

  it('knows its file among the changed paths of a vault', () => {
    expect(isLibraryPath('.clarae/excalidraw-library.json')).toBe(true);
    expect(isLibraryPath('.memobrain/excalidraw-library.json')).toBe(true);
    expect(isLibraryPath('excalidraw-library.json')).toBe(true);
    expect(isLibraryPath('Notes/my-excalidraw-library.json')).toBe(false);
    expect(isLibraryPath('.clarae/drawing.json')).toBe(false);
  });
});
