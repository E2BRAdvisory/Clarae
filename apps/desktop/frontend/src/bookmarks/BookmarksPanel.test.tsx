import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookmarksPanel } from './BookmarksPanel';
import { addBookmark, activateBookmark } from './actions';
import {
  captureGraphOptions,
  hasGraphBookmarks,
  openGraph,
  registerGraphBookmarks,
} from './graphHook';
import { addItem, fileItem, groupItem, parseBookmarks } from './model';
import { useBookmarks } from './store';
import { api, linkInfo } from '../app/api';
import { renameEntry } from '../app/actions';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { emptyLayout } from '../workspace/layout';
import { activeTab } from '../workspace/layout';

let mock: WailsMock;
let vaultId = '';
let seq = 0;

async function openVault(files: Record<string, string>, bookmarks?: unknown): Promise<void> {
  mock = installWailsMock();
  const v = await api.vault.open(`/v/Bm${++seq}`);
  vaultId = v.id;
  const vf = mock.vaults.get(v.id)?.files;
  for (const [p, c] of Object.entries(files)) vf?.set(p, c);
  if (bookmarks) vf?.set('.nodus/bookmarks.json', JSON.stringify(bookmarks));
  useAppStore.setState({ vault: v, layout: emptyLayout() });
  await waitFor(() => expect(useBookmarks.getState().loaded).toBe(true));
}

const panel = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BookmarksPanel vaultId={vaultId} />
    </QueryClientProvider>,
  );

describe('bookmarks', () => {
  beforeEach(() => {
    initI18n('en');
    useAppStore.setState({ vault: null, layout: emptyLayout() });
    useSync.setState({ info: {} });
  });

  it('loads .nodus/bookmarks.json, lists items and opens a note at its heading', async () => {
    await openVault(
      { 'A.md': '# Intro\n\ntext', 'B.md': '' },
      {
        items: [
          { type: 'file', path: 'A.md', subpath: '#Intro' },
          { type: 'group', title: 'Reading', items: [{ type: 'file', path: 'B.md' }] },
          { type: 'file', path: 'Gone.md' },
        ],
      },
    );
    panel();
    expect(await screen.findByText('A > Intro')).toBeInTheDocument();
    expect(screen.getByText('Reading')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    // A bookmark whose file disappeared is marked, not dropped.
    await waitFor(() => expect(screen.getByText('Gone').closest('.node')).toHaveClass('missing'));

    fireEvent.click(screen.getByText('A > Intro'));
    await waitFor(() => expect(activeTab(useAppStore.getState().layout)?.path).toBe('A.md'));
    expect(useAppStore.getState().reveal?.heading).toBe('Intro');
  });

  it('adds a note bookmark, once, and persists it', async () => {
    await openVault({ 'A.md': 'x' });
    expect(addBookmark(fileItem('A.md'))).toBe(true);
    expect(addBookmark(fileItem('A.md'))).toBe(true); // duplicate: ignored
    expect(useBookmarks.getState().file.items).toHaveLength(1);
    await useBookmarks.getState().flush();
    const saved = parseBookmarks(
      mock.vaults.get(vaultId)?.files.get('.nodus/bookmarks.json') ?? '',
    );
    expect(saved.items.map((i) => i.path)).toEqual(['A.md']);
    expect(useAppStore.getState().left.tab).toBe('bookmarks');
  });

  it('follows renames done through renameEntry, even inside groups', async () => {
    await openVault({ 'Dir/A.md': 'x' });
    useBookmarks.getState().update((items) => {
      const g = addItem(items, groupItem('G'));
      return addItem(g, fileItem('Dir/A.md'), [0]);
    });
    await renameEntry('Dir/A.md', 'Dir/B.md');
    expect(useBookmarks.getState().file.items[0]?.items?.[0]?.path).toBe('Dir/B.md');
    await useBookmarks.getState().flush();
    expect(mock.vaults.get(vaultId)?.files.get('.nodus/bookmarks.json')).toContain('Dir/B.md');
  });

  it('reloads when the file changes outside the app, but ignores its own writes', async () => {
    await openVault({ 'A.md': 'x' }, { items: [{ type: 'file', path: 'A.md' }] });
    const files = mock.vaults.get(vaultId)?.files;
    files?.set(
      '.nodus/bookmarks.json',
      JSON.stringify({ items: [{ type: 'search', query: 'q' }] }),
    );
    act(() => mock.emit('vault:file-changed', { vaultId, paths: ['.nodus/bookmarks.json'] }));
    await waitFor(() => expect(useBookmarks.getState().file.items[0]?.type).toBe('search'));
  });

  it('cannot be edited in a read-only vault', async () => {
    await openVault({ 'A.md': 'x' }, { items: [{ type: 'file', path: 'A.md' }] });
    useSync.setState({ info: { [vaultId]: linkInfo({ linked: true, readOnly: true }) } });
    expect(addBookmark(fileItem('B.md'))).toBe(false);
    panel();
    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(screen.getByLabelText('New group')).toBeDisabled();
    expect(useBookmarks.getState().file.items).toHaveLength(1);
  });

  it('hands graph bookmarks to the graph module once registered', async () => {
    await openVault({});
    expect(openGraph({ depth: 1 })).toBe(false); // nothing registered: activation shows a notice
    const opened: Record<string, unknown>[] = [];
    registerGraphBookmarks({ open: (o) => opened.push(o), capture: () => ({ depth: 3 }) });
    try {
      expect(hasGraphBookmarks()).toBe(true);
      await activateBookmark({ type: 'graph', title: 'G', options: { depth: 2 } });
      expect(opened).toEqual([{ depth: 2 }]);
      expect(captureGraphOptions()).toEqual({ depth: 3 });
    } finally {
      registerGraphBookmarks(null);
    }
  });
});
