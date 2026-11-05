// Presenter notes typed in the Slideshow tab survive a switch to another tab of the pane within the
// typing delay: the note view clears the presentation, so it flushes the pending notes first.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { useMarpDeck } from '../marp/deckStore';
import { useMarpShow } from '../marp/showStore';
import { MarpSlidesPanel } from '../sidebar/MarpSlidesPanel';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { emptyLayout } from './layout';
import { WorkspaceView } from './WorkspaceView';

beforeAll(() => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  Range.prototype.getClientRects = () => none;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

const DECK = '---\nmarp: true\n---\n\n# One\n\n---\n\n## Two\n';
let mock: WailsMock;
let vaultId = '';

afterEach(() => {
  cleanup();
  useMarpDeck.getState().clear('Deck.marp');
});

describe('Slideshow notes and the tabs of the pane', () => {
  it('writes the pending notes when another tab is opened before the delay is over', async () => {
    initI18n('en');
    useSettings.getState().reset();
    mock = installWailsMock();
    const info = await api.vault.open('/vaults/Tabs');
    vaultId = info.id;
    mock.vaults.get(vaultId)?.files.set('Deck.marp', DECK);
    mock.vaults.get(vaultId)?.files.set('Other.md', '# Other');
    useMarpShow.setState({ open: false });
    useAppStore.setState({ layout: emptyLayout(), searchQuery: '' });
    useAppStore.getState().setVault(info);
    useAppStore.getState().openNote('Deck.marp');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <WorkspaceView vaultId={vaultId} />
        <MarpSlidesPanel vaultId={vaultId} path="Deck.marp" />
      </QueryClientProvider>,
    );
    const cards = await screen.findAllByTestId('marp-card');
    await waitFor(() =>
      expect(
        cards[0]?.querySelector('.slide-thumb')?.shadowRoot?.querySelector('svg'),
      ).not.toBeNull(),
    );
    fireEvent.click(cards[1] as HTMLElement);
    fireEvent.change(await screen.findByPlaceholderText(/presenter notes/i), {
      target: { value: 'do not lose me' },
    });
    // Another tab at once: the pane's note view (and the presentation in focus) goes away.
    act(() => useAppStore.getState().openNote('Other.md', { newTab: true }));
    await waitFor(() => expect(useMarpDeck.getState().path).not.toBe('Deck.marp'));
    await waitFor(
      () =>
        expect(mock.vaults.get(vaultId)?.files.get('Deck.marp')).toContain(
          '<!-- do not lose me -->',
        ),
      { timeout: 4000 },
    );
  }, 15000);
});
