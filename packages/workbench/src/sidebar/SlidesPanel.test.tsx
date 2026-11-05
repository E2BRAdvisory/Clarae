import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SlidesPanel } from './SlidesPanel';
import { api, linkInfo } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { useActiveNote } from '../state/activeNote';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { useSlideshow } from '../slides/store';
import { emptyLayout } from '../workspace/layout';

const DECK = '# One\n\n---\n\n# Two\n\nNote: n\n\n---\n\n# Three\n';

let mock: WailsMock;
let vaultId = '';

async function setup(path = 'Deck.md', content = DECK) {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Panel');
  vaultId = info.id;
  mock.vaults.get(vaultId)?.files.set(path, content);
  useAppStore.setState({ layout: emptyLayout(), stats: null });
  useAppStore.getState().setVault(info);
  useAppStore.getState().openNote(path);
  useSync.setState({ info: {} });
  useSlideshow.setState({ open: false });
  const reloaded: string[] = [];
  useActiveNote.getState().publish({
    vaultId,
    path,
    text: content,
    current: () => content,
    prepare: async () => (await api.vault.readNote(vaultId, path)).hash,
    reload: () => reloaded.push(path),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SlidesPanel vaultId={vaultId} />
    </QueryClientProvider>,
  );
  return { reloaded };
}

describe('Slides tab', () => {
  beforeEach(() => useActiveNote.setState({ note: null }));

  it('lists a thumbnail per slide and starts the presentation at the one clicked', async () => {
    await setup();
    const thumbs = await screen.findAllByRole('button', { name: /^Slide \d/ });
    expect(thumbs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Slide 1: One',
      'Slide 2: Two',
      'Slide 3: Three',
    ]);
    fireEvent.click(thumbs[1] as HTMLElement);
    expect(useSlideshow.getState()).toMatchObject({ open: true, path: 'Deck.md', index: 1 });
  });

  it('starts from the first slide with the button', async () => {
    await setup();
    act(() => useSlideshow.getState().start(vaultId, 'Other.md', 2));
    fireEvent.click(await screen.findByRole('button', { name: 'Start presentation' }));
    expect(useSlideshow.getState()).toMatchObject({ path: 'Deck.md', index: 0 });
  });

  it('writes the options into the frontmatter of the note', async () => {
    const { reloaded } = await setup();
    fireEvent.change(await screen.findByLabelText('Transition'), { target: { value: 'zoom' } });
    await waitFor(() =>
      expect(mock.vaults.get(vaultId)?.files.get('Deck.md')).toContain('slide-transition: zoom'),
    );
    expect(reloaded).toEqual(['Deck.md']);

    fireEvent.click(await screen.findByLabelText('Slide numbers'));
    await waitFor(() =>
      expect(mock.vaults.get(vaultId)?.files.get('Deck.md')).toContain('slide-numbers: true'),
    );
  });

  it('shows the options stored in the frontmatter of the note', async () => {
    await setup('Plain.md', '---\nslide-theme: dark\nslide-progress: false\n---\nJust text\n');
    expect(await screen.findByLabelText('Theme')).toHaveValue('dark');
    expect(screen.getByLabelText('Progress bar')).not.toBeChecked();
    // one slide is still a deck, but a note with nothing in the body has none
    expect(screen.getAllByRole('button', { name: /^Slide 1/ })).toHaveLength(1);
  });

  it('offers no slides for a note without content, and options are read-only on a read-only vault', async () => {
    await setup('Empty.md', '---\ntitle: x\n---\n');
    expect(await screen.findByText(/Separate the slides with/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start presentation' })).toBeDisabled();
  });

  it('asks for a Markdown note when the open file is something else', async () => {
    await setup('Board.canvas', '{}');
    expect(await screen.findByText('Open a Markdown note to present it.')).toBeInTheDocument();
  });
});

describe('Slides tab on a Marp presentation', () => {
  it('shows the slideshow panel of the presentation, not the note presentation', async () => {
    await setup('Talk.marp', '---\nmarp: true\n---\n\n# One\n');
    expect(screen.queryByText('Open a Markdown note to present it.')).toBeNull();
    expect(screen.queryByLabelText('Transition')).toBeNull();
    // The editor has not published the deck yet: the panel says so with its own empty state.
    expect(await screen.findByText('This presentation has no slides.')).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Slideshow' })).toBeInTheDocument();
  });
});

describe('Slides tab on a read-only vault', () => {
  it('disables the options but still lets the user present', async () => {
    await setup();
    act(() => {
      useSync.setState({
        info: {
          [vaultId]: linkInfo({ linked: true, mount: true, permission: 'viewer', readOnly: true }),
        },
      });
    });
    expect(await screen.findByLabelText('Transition')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start presentation' })).toBeEnabled();
  });
});
