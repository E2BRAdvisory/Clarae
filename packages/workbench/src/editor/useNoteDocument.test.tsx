import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { api, type WriteResult } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { flushAllNotes } from '../workspaces/flush';
import { useNoteDocument } from './useNoteDocument';

type WriteFn = (id: string, path: string, content: string, hash: string) => Promise<WriteResult>;

interface Bindings {
  go: { app: { VaultAPI: { WriteNote: WriteFn; ReadNote: unknown } } };
}

let mock: WailsMock;
let vaultId = '';

async function setup(files: Record<string, string>) {
  initI18n('en');
  mock = installWailsMock();
  vaultId = (await api.vault.open('/vaults/Doc')).id;
  for (const [p, c] of Object.entries(files)) mock.vaults.get(vaultId)?.files.set(p, c);
}

const disk = (path: string): string | undefined => mock.vaults.get(vaultId)?.files.get(path);
const hashOf = async (path: string): Promise<string> =>
  (await api.vault.readNote(vaultId, path)).hash;

/** Records every WriteNote and holds the return of the first `hold` ones until released. */
function interceptWrites(opts: { hold: number }) {
  const bindings = (window as unknown as Bindings).go.app.VaultAPI;
  const original = bindings.WriteNote;
  const calls: { content: string; hash: string; diskHash: string }[] = [];
  const held: (() => void)[] = [];
  bindings.WriteNote = async (id, path, content, hash) => {
    const before = mock.vaults.get(id)?.files.get(path);
    const diskHash = before === undefined ? '' : (await api.vault.readNote(id, path)).hash;
    calls.push({ content, hash, diskHash });
    // Like the Go backend: the file is written (and the watcher fires) before the call returns.
    const result = original(id, path, content, hash);
    if (calls.length > opts.hold) return result;
    await new Promise<void>((resolve) => held.push(resolve));
    return result;
  };
  return {
    calls,
    /** Lets the oldest held write return. */
    release: () => held.shift()?.(),
    pending: () => held.length,
  };
}

async function ready(path: string, debounceMs = 500) {
  const hook = renderHook(() => useNoteDocument(vaultId, path, debounceMs));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useNoteDocument', () => {
  it('overwrites a conflicting file with the editor text', async () => {
    await setup({ 'A.md': 'one' });
    const { result } = await ready('A.md');
    act(() => result.current.edit('mine'));
    mock.vaults.get(vaultId)?.files.set('A.md', 'theirs'); // changed on disk, watcher not fired yet
    let saved = true;
    await act(async () => {
      saved = await result.current.flush();
    });
    expect(saved).toBe(false);
    expect(result.current.save).toBe('conflict');
    expect(disk('A.md')).toBe('theirs');

    let written = false;
    await act(async () => {
      written = await result.current.overwrite();
    });
    expect(written).toBe(true);
    expect(result.current.save).toBe('saved');
    expect(disk('A.md')).toBe('mine');
    expect(result.current.savedHash()).toBe(await hashOf('A.md'));

    // Autosave works again afterwards.
    act(() => result.current.edit('mine, more'));
    await act(async () => {
      saved = await result.current.flush();
    });
    expect(saved).toBe(true);
    expect(disk('A.md')).toBe('mine, more');
  });

  it('overwrite creates the file again when it was deleted', async () => {
    await setup({ 'A.md': 'one' });
    const { result } = await ready('A.md');
    act(() => result.current.edit('kept'));
    mock.vaults.get(vaultId)?.files.delete('A.md');
    await act(async () => void (await result.current.flush()));
    expect(result.current.save).toBe('conflict');
    await act(async () => void (await result.current.overwrite()));
    expect(result.current.save).toBe('saved');
    expect(disk('A.md')).toBe('kept');
  });

  it('serializes overlapping saves: each write uses the hash of the previous one', async () => {
    await setup({ 'A.md': 'v0' });
    const { result } = await ready('A.md', 300);
    const writes = interceptWrites({ hold: Infinity });
    vi.useFakeTimers();

    act(() => result.current.edit('v1'));
    let first: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = result.current.flush(); // write of v1 in flight
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(writes.pending()).toBe(1);

    act(() => result.current.edit('v2'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(300))); // debounce fires
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      second = result.current.flush(); // and a flush on top of it
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(writes.calls).toHaveLength(1); // the second write waits for the first

    for (let i = 0; i < 5 && (writes.pending() || writes.calls.length < 2); i++) {
      await act(async () => {
        writes.release();
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    let results: boolean[] = [];
    await act(async () => {
      results = await Promise.all([first, second]);
    });

    expect(results[1]).toBe(true);
    expect(disk('A.md')).toBe('v2');
    expect(result.current.save).toBe('saved');
    // No write ever went out with a stale hash (which is what raises a self-conflict).
    expect(writes.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of writes.calls) expect(c.hash).toBe(c.diskHash);
  });

  it('does not take its own write for an external change while that write is in flight', async () => {
    await setup({ 'A.md': 'v0' });
    const { result } = await ready('A.md');
    const writes = interceptWrites({ hold: 1 });
    act(() => result.current.edit('v1'));
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = result.current.flush();
    });
    // The file is on disk and the watcher fired, but the call has not returned yet.
    await waitFor(() => expect(writes.pending()).toBe(1));
    expect(disk('A.md')).toBe('v1');
    act(() => result.current.edit('v1 and more')); // still typing: the document is dirty
    await act(async () => {
      writes.release();
      await done;
    });
    await waitFor(() => expect(result.current.save).toBe('saved'));
    expect(disk('A.md')).toBe('v1 and more');
    for (const c of writes.calls) expect(c.hash).toBe(c.diskHash);
  });

  it('writes pending edits on unmount after the write in flight, with its new hash', async () => {
    await setup({ 'A.md': 'v0' });
    const { result, unmount } = await ready('A.md');
    const writes = interceptWrites({ hold: 1 });
    act(() => result.current.edit('v1'));
    act(() => void result.current.flush());
    await waitFor(() => expect(writes.pending()).toBe(1));
    act(() => result.current.edit('v2'));
    unmount();
    expect(writes.calls).toHaveLength(1);
    writes.release();
    await waitFor(() => expect(disk('A.md')).toBe('v2'));
    expect(writes.calls.map((c) => c.content)).toEqual(['v1', 'v2']);
    for (const c of writes.calls) expect(c.hash).toBe(c.diskHash);
  });

  it('keeps the edits of a conflicted note closed in a copy next to it', async () => {
    await setup({ 'Dir/A.md': 'one' });
    const { result, unmount } = await ready('Dir/A.md');
    act(() => result.current.edit('mine'));
    mock.vaults.get(vaultId)?.files.set('Dir/A.md', 'theirs');
    await act(async () => void (await result.current.flush()));
    expect(result.current.save).toBe('conflict');
    unmount();
    await waitFor(() => {
      const copies = [...(mock.vaults.get(vaultId)?.files.keys() ?? [])].filter((p) =>
        /^Dir\/A \(unsaved \d{4}-\d\d-\d\d \d\d-\d\d\)\.md$/.test(p),
      );
      expect(copies).toHaveLength(1);
      expect(disk(copies[0] as string)).toBe('mine');
    });
    expect(disk('Dir/A.md')).toBe('theirs');
  });

  it('reports the documents whose edits cannot be saved, and rescues them on request', async () => {
    await setup({ 'A.md': 'one', 'B.md': 'two' });
    const a = await ready('A.md');
    const b = await ready('B.md');
    act(() => a.result.current.edit('a!'));
    act(() => b.result.current.edit('b!'));
    mock.vaults.get(vaultId)?.files.set('B.md', 'theirs');
    let report = await flushAllNotes();
    expect(report).toEqual({ failed: ['B.md'], rescued: [] });
    expect(disk('A.md')).toBe('a!');
    report = await flushAllNotes({ rescue: true });
    expect(report.failed).toEqual([]);
    expect(report.rescued).toHaveLength(1);
    expect(disk(report.rescued[0] as string)).toBe('b!');
    a.unmount();
    b.unmount();
  });

  it('refresh shows a new version when clean and keeps unsaved edits as a conflict', async () => {
    await setup({ 'A.md': 'one' });
    const { result } = await ready('A.md');
    mock.vaults.get(vaultId)?.files.set('A.md', 'two');
    await act(async () => void (await result.current.refresh()));
    expect(result.current.current()).toBe('two');
    act(() => result.current.edit('typed'));
    mock.vaults.get(vaultId)?.files.set('A.md', 'three');
    await act(async () => void (await result.current.refresh()));
    expect(result.current.current()).toBe('typed');
    expect(result.current.save).toBe('conflict');
  });
});
