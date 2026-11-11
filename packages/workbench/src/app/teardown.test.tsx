// Pending edits survive the operations that make an open note go away (D-04): closing the vault,
// writing a property over a note in conflict, the desktop window closing, leaving the Web UI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { api } from './api';
import { Events } from './events';
import { renameEntry } from './actions';
import { installLifecycle } from './lifecycle';
import { capabilitiesFor } from '../platform';
import { runCommand } from '../commands/registry';
import { getEditor } from '../editor/registry';
import { useNoteDocument } from '../editor/useNoteDocument';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useSettings } from '../state/settings';
import { useBookmarks } from '../bookmarks/store';
import { fileItem } from '../bookmarks/model';
import { useAppStore } from '../state/store';
import { DialogHost } from '../ui/dialogs';
import { allPanes, emptyLayout } from '../workspace/layout';

let mock: WailsMock;
let vaultId = '';

async function openVault(files: Record<string, string>) {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Teardown');
  vaultId = info.id;
  for (const [p, c] of Object.entries(files)) mock.vaults.get(vaultId)?.files.set(p, c);
  useAppStore.setState({
    layout: emptyLayout(),
    searchQuery: '',
    paletteOpen: false,
    switcherOpen: false,
    settingsOpen: false,
  });
  useAppStore.getState().setVault(info);
  return info;
}

const disk = (path: string): string | undefined => mock.vaults.get(vaultId)?.files.get(path);

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

/** Types at the end of the note open in the (only) pane, like the user would. */
async function typeAtEnd(text: string) {
  await screen.findByLabelText('Note editor');
  const paneId = allPanes(useAppStore.getState().layout.root)[0]?.id ?? '';
  const view = await waitFor(() => {
    const v = getEditor(paneId);
    if (!v) throw new Error('no editor yet');
    return v;
  });
  act(() => {
    const base = view.text();
    view.applySourceEdits(base, [{ from: base.length, insert: text }]);
  });
  return view;
}

describe('teardown flush', () => {
  beforeEach(() => useSettings.getState().reset());
  afterEach(() => vi.restoreAllMocks());

  it('vault:close writes the pending edits before the vault is closed', async () => {
    await openVault({ 'Home.md': '# Home' });
    useAppStore.getState().openNote('Home.md');
    renderApp();
    await typeAtEnd('\nlast words');
    // Closed right away, before the autosave delay elapses.
    const bindings = (window as unknown as { go: { app: { VaultAPI: Record<string, unknown> } } })
      .go.app.VaultAPI;
    const close = bindings['CloseVault'] as (id: string) => Promise<void>;
    let atClose: string | undefined;
    bindings['CloseVault'] = (id: string) => {
      atClose = disk('Home.md');
      return close(id);
    };
    await act(async () => {
      await runCommand('vault:close');
    });
    expect(atClose).toBe('# Home\nlast words');
    expect(useAppStore.getState().vault).toBeNull();
  });

  it('a property edit on a note in conflict keeps the editor text and writes nothing', async () => {
    await openVault({ 'Home.md': '---\nstatus: draft\n---\n# Home' });
    useAppStore.getState().openNote('Home.md');
    useAppStore.getState().setRight({ open: true, tab: 'properties' });
    renderApp();
    const view = await typeAtEnd('\ntyped');
    // Somebody else changes the file; the next save finds the conflict.
    mock.vaults.get(vaultId)?.files.set('Home.md', '---\nstatus: draft\n---\n# Theirs');
    expect(
      await screen.findByText(/changed on disk/, undefined, { timeout: 3000 }),
    ).toBeInTheDocument();

    const update = vi.spyOn(api.properties, 'update');
    const input = screen.getByDisplayValue('draft');
    fireEvent.change(input, { target: { value: 'final' } });
    fireEvent.blur(input);
    expect(await screen.findByText(/changes that are not saved yet/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(view.text()).toBe('---\nstatus: draft\n---\n# Home\ntyped');
    expect(disk('Home.md')).toBe('---\nstatus: draft\n---\n# Theirs');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  });

  it('a rename writes pending edits first and is refused while they cannot be saved', async () => {
    await openVault({ 'A.md': 'one', 'B.md': 'two' });
    const a = renderHook(() => useNoteDocument(vaultId, 'A.md'));
    const b = renderHook(() => useNoteDocument(vaultId, 'B.md'));
    await waitFor(() => expect(a.result.current.status).toBe('ready'));
    await waitFor(() => expect(b.result.current.status).toBe('ready'));
    act(() => a.result.current.edit('one, edited'));
    act(() => b.result.current.edit('two, edited'));
    mock.vaults.get(vaultId)?.files.set('B.md', 'theirs');

    let res: Awaited<ReturnType<typeof renameEntry>> = null;
    await act(async () => {
      res = await renameEntry('A.md', 'A2.md');
    });
    expect(res).not.toBeNull();
    expect(disk('A2.md')).toBe('one, edited'); // flushed, then moved

    render(<DialogHost />);
    const refused = renameEntry('B.md', 'B2.md');
    // Earlier tests may have left notices queued (a note closed in conflict is rescued and told).
    await waitFor(() => {
      if (screen.queryByText(/are not saved yet/)) return;
      const ok = screen.queryByRole('button', { name: 'OK' });
      if (ok) fireEvent.click(ok);
      throw new Error('waiting for the rename notice');
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await act(async () => {
      res = await refused;
    });
    expect(res).toBeNull();
    expect(disk('B.md')).toBe('theirs');
    expect(disk('B2.md')).toBeUndefined();
    expect(b.result.current.current()).toBe('two, edited');
  });

  it('desktop: the window closing flushes the notes, then quits', async () => {
    await openVault({ 'A.md': 'one' });
    const off = installLifecycle(capabilitiesFor('desktop'));
    try {
      const { result } = renderHook(() => useNoteDocument(vaultId, 'A.md'));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      act(() => result.current.edit('closing words'));
      act(() => mock.emit(Events.appBeforeClose, undefined));
      await waitFor(() => expect(mock.quits).toBe(1));
      expect(disk('A.md')).toBe('closing words');
    } finally {
      off();
    }
  });

  it('desktop: the window closing writes the settings and bookmarks still waiting', async () => {
    await openVault({ 'A.md': 'one' });
    await useSettings.getState().load(vaultId);
    await useBookmarks.getState().load(vaultId);
    const off = installLifecycle(capabilitiesFor('desktop'));
    try {
      useSettings.getState().setEditor({ lineNumbers: true });
      useBookmarks.getState().update((items) => [...items, fileItem('A.md', '', 1)]);
      act(() => mock.emit(Events.appBeforeClose, undefined));
      await waitFor(() => expect(mock.quits).toBe(1));
      expect(JSON.parse(disk('.memobrain/editor.json') ?? '{}')).toMatchObject({
        lineNumbers: true,
      });
      expect(disk('.memobrain/bookmarks.json')).toContain('A.md');
    } finally {
      off();
    }
  });

  it('web: hiding the page writes the settings still waiting', async () => {
    await openVault({ 'A.md': 'one' });
    await useSettings.getState().load(vaultId);
    const off = installLifecycle(capabilitiesFor('web'));
    try {
      useSettings.getState().setEditor({ wrap: false });
      const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      hidden.mockRestore();
      // Well before the settings' own delay (400 ms): the write was started by the hide.
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(JSON.parse(disk('.memobrain/editor.json') ?? '{}')).toMatchObject({ wrap: false });
    } finally {
      off();
    }
  });

  it('web: leaving the page with unsaved edits asks the browser to confirm', async () => {
    await openVault({ 'A.md': 'one' });
    const off = installLifecycle(capabilitiesFor('web'));
    try {
      const { result } = renderHook(() => useNoteDocument(vaultId, 'A.md'));
      await waitFor(() => expect(result.current.status).toBe('ready'));
      const leave = () => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      expect(leave()).toBe(false);
      act(() => result.current.edit('two'));
      expect(leave()).toBe(true);
      await waitFor(() => expect(disk('A.md')).toBe('two')); // and the write has started
      expect(leave()).toBe(false);
    } finally {
      off();
    }
  });
});
