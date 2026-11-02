import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from './StatusBar';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { defaultAppearance, useSettings } from '../state/settings';
import { useSlideshow } from '../slides/store';
import { useAppStore } from '../state/store';
import { activeTab, emptyLayout } from '../workspace/layout';

let mock: WailsMock;
let vaultId = '';

function bar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StatusBar vaultId={vaultId} />
    </QueryClientProvider>,
  );
}

const show = (statusBar: boolean): void =>
  useSettings.setState({ appearance: { ...defaultAppearance, statusBar } });

const stats = { words: 5, chars: 33, selWords: 0, selChars: 0, line: 3, col: 7 };

describe('status bar (ADR-0035)', () => {
  beforeEach(async () => {
    initI18n('en');
    mock = installWailsMock();
    const info = await api.vault.open('/vaults/Status');
    vaultId = info.id;
    const files = mock.vaults.get(vaultId)?.files;
    files?.set('Home.md', '---\ncreated: 2025-05-04\n---\n# Home\nhello brave world\n## Next\n');
    files?.set('Board.canvas', '{"nodes":[],"edges":[]}');
    useAppStore.setState({ layout: emptyLayout(), stats: null });
    useAppStore.getState().setVault(info);
    useSlideshow.setState({ open: false });
    show(true);
  });

  it('is off by default', () => {
    show(defaultAppearance.statusBar);
    useAppStore.getState().openNote('Home.md');
    const { container } = bar();
    expect(container).toBeEmptyDOMElement();
  });

  it('is empty without an active tab', () => {
    bar();
    expect(screen.getByRole('status', { name: 'Status bar' })).toBeEmptyDOMElement();
  });

  it('shows the words and characters of the note, the cursor and the mode', async () => {
    useAppStore.getState().openNote('Home.md', { mode: 'live' });
    act(() => useAppStore.getState().setStats(stats));
    bar();
    const status = screen.getByRole('status', { name: 'Status bar' });
    // the body of the note, without the frontmatter, as in the Statistics panel
    expect(await screen.findByText('5 words, 33 chars')).toBeInTheDocument();
    expect(status).toHaveTextContent('Ln 3, Col 7');
    expect(status).not.toHaveAttribute('aria-live');
  });

  it('shows the selection in place of the counts of the note', async () => {
    useAppStore.getState().openNote('Home.md', { mode: 'live' });
    act(() => useAppStore.getState().setStats({ ...stats, selWords: 2, selChars: 11 }));
    bar();
    expect(await screen.findByText('2 words, 11 chars selected')).toBeInTheDocument();
    expect(screen.queryByText('5 words, 33 chars')).toBeNull();
  });

  it('cycles the mode of the tab on click, without the cursor in reading view', async () => {
    useAppStore.getState().openNote('Home.md', { mode: 'source' });
    act(() => useAppStore.getState().setStats(stats));
    bar();
    await screen.findByText('5 words, 33 chars');
    fireEvent.click(screen.getByRole('button', { name: 'Mode: Source. Click to switch' }));
    expect(activeTab(useAppStore.getState().layout)?.mode).toBe('reading');
    expect(screen.queryByText('Ln 3, Col 7')).toBeNull();
    expect(screen.getByText('5 words, 33 chars')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mode: Reading. Click to switch' }));
    expect(activeTab(useAppStore.getState().layout)?.mode).toBe('live');
  });

  it('shows only the type of a file that is not a note', () => {
    useAppStore.getState().openNote('Board.canvas');
    act(() => useAppStore.getState().setStats(stats));
    bar();
    const status = screen.getByRole('status', { name: 'Status bar' });
    expect(status).toHaveTextContent(/^Canvas$/);
  });

  it('hides during a presentation', () => {
    useAppStore.getState().openNote('Home.md');
    useSlideshow.setState({ open: true });
    const { container } = bar();
    expect(container).toBeEmptyDOMElement();
  });
});
