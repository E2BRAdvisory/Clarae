import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { installWailsMock } from '../test/wails-mock';
import { MarpShow } from './MarpShow';
import { useMarpShow } from './showStore';

const slides = (): SVGSVGElement[] => [
  ...(screen
    .getByTestId('marp-show')
    .shadowRoot?.querySelectorAll<SVGSVGElement>('div.marpit > svg') ?? []),
];
const current = (): number => slides().findIndex((s) => s.classList.contains('current'));

let vaultId = '';

async function start(content: string, from = 0) {
  const mock = installWailsMock();
  const info = await api.vault.open('/vaults/Show');
  vaultId = info.id;
  mock.vaults.get(vaultId)?.files.set('Deck.marp', content);
  useAppStore.getState().setVault(info);
  render(<MarpShow />);
  act(() => useMarpShow.getState().start(vaultId, 'Deck.marp', from));
  await waitFor(() => expect(slides().length).toBeGreaterThan(0));
}

const press = (key: string) => fireEvent.keyDown(window, { key });

const DECK = '---\nmarp: true\n---\n\n# One\n\n---\n\n## Two\n\n---\n\n## Three\n';

describe('Marp full-screen presentation', () => {
  beforeEach(() => initI18n('en'));
  afterEach(() => {
    cleanup();
    useMarpShow.setState({ open: false });
  });

  it('shows one slide at a time, moved with the keys, until Escape', async () => {
    await start(DECK);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(current()).toBe(0);
    press('ArrowRight');
    await waitFor(() => expect(current()).toBe(1));
    press(' ');
    await waitFor(() => expect(current()).toBe(2));
    press('ArrowRight'); // stays on the last one
    await waitFor(() => expect(current()).toBe(2));
    press('Home');
    await waitFor(() => expect(current()).toBe(0));
    press('End');
    await waitFor(() => expect(current()).toBe(2));
    press('ArrowLeft');
    await waitFor(() => expect(current()).toBe(1));
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    press('Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useMarpShow.getState().open).toBe(false);
  });

  it('starts from the slide asked for', async () => {
    await start(DECK, 2);
    expect(current()).toBe(2);
  });

  it('skips the slides that are left out, and starts at the next included one', async () => {
    await start(
      `${DECK}\n---\n\n## Four\n`.replace('## Two\n', '## Two\n\n<!-- clarae: hidden -->\n'),
      1,
    );
    // Two is left out: the show is One, Three and Four, and starts at Three.
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(current()).toBe(2);
    press('ArrowLeft');
    await waitFor(() => expect(current()).toBe(0));
    press('ArrowRight');
    await waitFor(() => expect(current()).toBe(2));
    expect(screen.queryByRole('option', { name: /Two/ })).toBeNull();
  });

  it('loops when the presentation asks for it', async () => {
    await start(DECK.replace('marp: true', 'marp: true\nclarae-loop: true'));
    press('ArrowLeft');
    await waitFor(() => expect(current()).toBe(2));
    press('ArrowRight');
    await waitFor(() => expect(current()).toBe(0));
  });

  it('shows the presenter notes, unless the presentation turns them off', async () => {
    await start(
      `${DECK}\n<!-- remember the demo -->\n`.replace('## Two\n', '## Two\n\n<!-- say hi -->\n'),
    );
    press('ArrowRight');
    expect(await screen.findByText('say hi')).toBeInTheDocument();
    cleanup();
    useMarpShow.setState({ open: false });
    await start(
      DECK.replace('marp: true', 'marp: true\nclarae-notes: false').replace(
        '## Two\n',
        '## Two\n\n<!-- say hi -->\n',
      ),
      1,
    );
    expect(screen.queryByText('say hi')).toBeNull();
  });

  it('shows a note without the invisible character that guards it from being a directive', async () => {
    await start(DECK.replace('## Two\n', '## Two\n\n<!-- theme\u200b: dark -->\n'), 1);
    const note = await screen.findByText('theme: dark');
    expect(note.textContent).not.toContain('\u200b');
  });

  it('moves with the slide list and the buttons of the bar', async () => {
    await start(DECK);
    fireEvent.change(screen.getByRole('combobox', { name: 'Slide' }), { target: { value: '2' } });
    await waitFor(() => expect(current()).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    await waitFor(() => expect(current()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'End presentation' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when every slide is left out', async () => {
    const mock = installWailsMock();
    const info = await api.vault.open('/vaults/Show');
    mock.vaults.get(info.id)?.files.set('Deck.marp', '# Only\n\n<!-- clarae: hidden -->\n');
    useAppStore.getState().setVault(info);
    render(<MarpShow />);
    act(() => useMarpShow.getState().start(info.id, 'Deck.marp', 0));
    expect(
      await screen.findByText('Every slide is left out of the presentation.'),
    ).toBeInTheDocument();
  });
});
