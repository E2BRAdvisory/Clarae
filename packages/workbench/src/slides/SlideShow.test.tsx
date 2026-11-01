import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SlideShow } from './SlideShow';
import { useSlideshow } from './store';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { configurePlatform } from '../platform';

const DECK =
  '---\nslide-transition: none\n---\n# First\n\nNote: say hello\n\n---\n\n# Second\n\n---\n\n# Third\n';

let vaultId = '';

function show(deck = DECK) {
  installWailsMock();
  return api.vault.open('/vaults/Slides').then(async (info) => {
    vaultId = info.id;
    await api.vault.writeNote(vaultId, 'Deck.md', deck, '');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SlideShow />
      </QueryClientProvider>,
    );
    act(() => useSlideshow.getState().start(vaultId, 'Deck.md', 0));
    return screen.findByRole('dialog', { name: 'Presentation' });
  });
}

const key = (el: HTMLElement, k: string) => fireEvent.keyDown(el, { key: k });

describe('presentation', () => {
  beforeEach(() => {
    initI18n('en');
    useSlideshow.setState({ open: false });
  });

  it('shows nothing until it is started', () => {
    installWailsMock();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <SlideShow />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves between slides with the keyboard, within the bounds of the deck', async () => {
    const dialog = await show();
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Slide 1 of 3');

    key(dialog, 'ArrowRight');
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Slide 2 of 3');

    key(dialog, ' ');
    expect(await screen.findByText('Third')).toBeInTheDocument();
    key(dialog, 'ArrowRight'); // already on the last one
    expect(useSlideshow.getState().index).toBe(2);

    key(dialog, 'Home');
    expect(await screen.findByText('First')).toBeInTheDocument();
    key(dialog, 'ArrowLeft'); // already on the first one
    expect(useSlideshow.getState().index).toBe(0);
    key(dialog, 'End');
    expect(await screen.findByText('Third')).toBeInTheDocument();
  });

  it('opens a link of a slide outside the app without navigating or advancing', async () => {
    configurePlatform({ kind: 'web' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await show('# One\n\n[docs](https://example.com/)\n\n---\n\n# Two\n');
      // The surface is hidden until it is measured (jsdom has no layout): find the text, not the role.
      const link = (await screen.findByText('docs')).closest('a') as HTMLAnchorElement;
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => void link.dispatchEvent(ev));
      expect(ev.defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
      expect(useSlideshow.getState().index).toBe(0);
    } finally {
      open.mockRestore();
      configurePlatform();
    }
  });

  it('starts from a given slide and advances on a click', async () => {
    await show();
    act(() => useSlideshow.getState().start(vaultId, 'Deck.md', 1));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    fireEvent.click(document.querySelector('.slide-stage') as HTMLElement);
    expect(await screen.findByText('Third')).toBeInTheDocument();
  });

  it('shows the speaker notes and the next slide in the presenter view', async () => {
    const dialog = await show();
    await screen.findByText('First');
    expect(screen.queryByText('say hello')).toBeNull(); // notes are never on the slide itself

    key(dialog, 'p');
    expect(await screen.findByText('say hello')).toBeInTheDocument();
    expect(await screen.findByText('Second')).toBeInTheDocument(); // the next slide
    expect(screen.getByLabelText('Elapsed time')).toHaveTextContent('00:00');

    key(dialog, 'ArrowRight');
    expect(await screen.findByText('No notes for this slide.')).toBeInTheDocument();
    key(dialog, 'p');
    expect(screen.queryByLabelText('Speaker notes')).toBeNull();
  });

  it('ends with Escape and with the button, and leaves the application hotkeys alone', async () => {
    const dialog = await show();
    await screen.findByText('First');
    const seen: KeyboardEvent[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e);
    window.addEventListener('keydown', spy);
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    window.removeEventListener('keydown', spy);
    expect(seen[0]?.defaultPrevented).toBe(true); // App's hotkey handler ignores it

    key(dialog, 'Escape');
    expect(useSlideshow.getState().open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => useSlideshow.getState().start(vaultId, 'Deck.md', 0));
    fireEvent.click(await screen.findByRole('button', { name: 'End presentation' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when the note has nothing to show', async () => {
    await show('---\ntitle: empty\n---\n');
    expect(await screen.findByText('This note has no slides to show.')).toBeInTheDocument();
  });
});
