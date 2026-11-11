import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { MarpSlidesPanel } from './MarpSlidesPanel';
import { api } from '../app/api';
import { codeMirrorHandle } from '../editor/source/CodeMirrorAdapter';
import { registerEditor, unregisterEditor } from '../editor/registry';
import { initI18n } from '../i18n';
import { applyEdit } from '../marp/controller';
import { useMarpDeck } from '../marp/deckStore';
import { useMarpShow } from '../marp/showStore';
import { installWailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';

vi.mock('../marp/controller', async (orig) => {
  const m = await orig<Record<string, unknown>>();
  return { ...m, applyEdit: vi.fn(m['applyEdit'] as typeof applyEdit) };
});

// jsdom cannot measure text: CodeMirror's own measuring (it runs after a change) gets empty answers.
beforeAll(() => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  Range.prototype.getClientRects = () => none;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

const DECK = '---\nmarp: true\n---\n\n# One\n\n---\n\n## Two\n\n---\n\n## Three\n';

let vaultId = '';
let view: EditorView;

async function setup(opts: { readOnly?: boolean; doc?: string } = {}) {
  initI18n('en');
  installWailsMock();
  const info = await api.vault.open('/vaults/Panel');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  const doc = opts.doc ?? DECK;
  view = new EditorView({ state: EditorState.create({ doc, extensions: [history()] }) });
  registerEditor('p1', codeMirrorHandle(view, { paneId: 'p1' }));
  useMarpShow.setState({ open: false });
  useMarpDeck.getState().publish({
    vaultId,
    path: 'Deck.marp',
    paneId: 'p1',
    source: doc,
    readOnly: !!opts.readOnly,
  });
  render(<MarpSlidesPanel vaultId={vaultId} path="Deck.marp" />);
  await screen.findAllByTestId('marp-card');
  // The cards are written from the render of the text: wait for it to be current.
  await waitFor(() =>
    expect(
      cards()[0]?.querySelector('.slide-thumb')?.shadowRoot?.querySelector('svg'),
    ).not.toBeNull(),
  );
}

afterEach(() => {
  cleanup();
  unregisterEditor('p1', codeMirrorHandle(view));
  view.destroy();
  useMarpDeck.getState().clear('Deck.marp');
});

const cards = (): HTMLElement[] => screen.getAllByTestId('marp-card');
const titles = (): string[] => cards().map((c) => c.querySelector('.title')?.textContent ?? '');

describe('Slideshow tab of a presentation', () => {
  beforeEach(() => cleanup());

  it('shows a card per slide, with the summary and a thumbnail in a shadow root', async () => {
    await setup();
    expect(titles()).toEqual(['1. One', '2. Two', '3. Three']);
    expect(screen.getByText('Slideshow · 3 of 3 slides included')).toBeInTheDocument();
    const thumb = cards()[0]?.querySelector('.slide-thumb');
    await waitFor(() => expect(thumb?.shadowRoot?.querySelector('svg')).not.toBeNull());
    expect(thumb?.shadowRoot?.querySelector('style')?.textContent).toContain('div.marpit');
    // No inline style of the application's own in the cards' DOM.
    expect(cards()[0]?.querySelector('[style]')).toBeNull();
  });

  it('moves a slide as one undoable change of the editor', async () => {
    await setup();
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Move down' }));
    expect(view.state.doc.toString()).toBe(
      '---\nmarp: true\n---\n\n## Two\n\n---\n\n# One\n\n---\n\n## Three\n',
    );
    await waitFor(() => expect(titles()).toEqual(['1. Two', '2. One', '3. Three']));
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe(DECK); // one transaction, one undo step
  });

  it('leaves a slide out and puts it back, and updates the summary', async () => {
    await setup();
    fireEvent.click(
      within(cards()[1] as HTMLElement).getByRole('button', {
        name: 'Leave out of the presentation',
      }),
    );
    expect(view.state.doc.toString()).toContain('<!-- memobrain: hidden -->');
    await waitFor(() =>
      expect(screen.getByText('Slideshow · 2 of 3 slides included')).toBeInTheDocument(),
    );
    expect(cards()[1]).toHaveClass('excluded');
    fireEvent.click(
      within(cards()[1] as HTMLElement).getByRole('button', {
        name: 'Include in the presentation',
      }),
    );
    await waitFor(() => expect(view.state.doc.toString()).toBe(DECK));
  });

  it('excludes and includes all the slides from the menu', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByText('Exclude all slides'));
    expect(view.state.doc.toString().match(/memobrain: hidden/g)).toHaveLength(3);
    await waitFor(() =>
      expect(screen.getByText('Slideshow · 0 of 3 slides included')).toBeInTheDocument(),
    );
  });

  it('writes the presenter notes after typing stops', async () => {
    await setup();
    fireEvent.click(cards()[1] as HTMLElement);
    fireEvent.change(await screen.findByPlaceholderText(/presenter notes/i), {
      target: { value: 'say hello' },
    });
    await waitFor(() => expect(view.state.doc.toString()).toContain('<!-- say hello -->'), {
      timeout: 3000,
    });
  });

  it('writes the notes of a card that closes before the delay is over', async () => {
    await setup();
    fireEvent.click(cards()[1] as HTMLElement);
    fireEvent.change(await screen.findByPlaceholderText(/presenter notes/i), {
      target: { value: 'quick note' },
    });
    expect(view.state.doc.toString()).not.toContain('quick note');
    fireEvent.click(cards()[2] as HTMLElement); // another card: the notes box of this one goes away
    await waitFor(() => expect(view.state.doc.toString()).toContain('<!-- quick note -->'));
  });

  it('writes the pending notes before it moves the slide', async () => {
    await setup();
    fireEvent.click(cards()[1] as HTMLElement);
    fireEvent.change(await screen.findByPlaceholderText(/presenter notes/i), {
      target: { value: 'carried' },
    });
    fireEvent.click(within(cards()[1] as HTMLElement).getByRole('button', { name: 'Move up' }));
    await waitFor(() => {
      const doc = view.state.doc.toString();
      expect(doc).toContain('<!-- carried -->');
      expect(doc.indexOf('## Two')).toBeLessThan(doc.indexOf('# One'));
    });
  });

  it('does not wait for a re-render that never comes after notes that end with a newline', async () => {
    await setup();
    fireEvent.click(cards()[1] as HTMLElement);
    fireEvent.change(await screen.findByPlaceholderText(/presenter notes/i), {
      target: { value: 'Hello\n' },
    });
    await waitFor(() => expect(view.state.doc.toString()).toContain('<!-- Hello -->'), {
      timeout: 3000,
    });
    await new Promise((r) => setTimeout(r, 1500)); // the re-render, and the box catching up
    fireEvent.click(
      within(cards()[2] as HTMLElement).getByRole('button', {
        name: 'Leave out of the presentation',
      }),
    );
    await waitFor(() => expect(view.state.doc.toString()).toContain('memobrain: hidden'), {
      timeout: 1500,
    });
    // ...and nothing fires later on its own
    const after = view.state.doc.toString();
    await new Promise((r) => setTimeout(r, 1200));
    expect(view.state.doc.toString()).toBe(after);
  }, 15000);

  it('reports an edit that leaves the text as it was, and does not record an undo step', () => {
    const doc = '# A\n\n<!-- n -->\n';
    const v = new EditorView({ state: EditorState.create({ doc, extensions: [history()] }) });
    registerEditor('p9', codeMirrorHandle(v, { paneId: 'p9' }));
    useMarpDeck.getState().publish({
      vaultId: 'x',
      path: 'Z.marp',
      paneId: 'p9',
      source: doc,
      readOnly: false,
    });
    try {
      const real = vi.mocked(applyEdit).getMockImplementation() as typeof applyEdit;
      expect(real(doc, [{ from: 5, to: 15, insert: '<!-- n -->' }])).toBe('noop');
      expect(real(doc, [])).toBe('noop');
      expect(real(doc, [{ from: 0, insert: 'x' }])).toBe('changed');
      expect(real(doc, [{ from: 0, insert: 'y' }])).toBe(false); // the text moved on
    } finally {
      unregisterEditor('p9', codeMirrorHandle(v));
      v.destroy();
      useMarpDeck.getState().clear('Z.marp');
    }
  });

  it('shows a note without the invisible character that keeps it from being a directive', async () => {
    await setup({ doc: '# One\n\n<!-- theme\u200b: dark -->\n\n---\n\n## Two\n' });
    fireEvent.click(cards()[0] as HTMLElement);
    const box = await screen.findByPlaceholderText<HTMLTextAreaElement>(/presenter notes/i);
    expect(box.value).toBe('theme: dark');
    fireEvent.change(box, { target: { value: 'class: lead' } });
    await waitFor(() => expect(view.state.doc.toString()).toContain('class\u200b: lead'), {
      timeout: 3000,
    });
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>(/presenter notes/i).value).toBe(
      'class: lead',
    );
  }, 15000);

  it('gives up on notes the editor keeps refusing instead of trying forever', async () => {
    await setup();
    fireEvent.click(cards()[1] as HTMLElement);
    // The editor's text moves on without the store hearing of it: every edit is refused.
    act(() => view.dispatch({ changes: { from: 0, insert: ' ' } }));
    vi.mocked(applyEdit).mockClear();
    fireEvent.change(await screen.findByPlaceholderText(/presenter notes/i), {
      target: { value: 'never lands' },
    });
    await new Promise((r) => setTimeout(r, 2800));
    const calls = vi.mocked(applyEdit).mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(6);
    await new Promise((r) => setTimeout(r, 900));
    expect(vi.mocked(applyEdit).mock.calls.length).toBe(calls);
  }, 10_000);

  it('edits a presentation whose text came with CRLF line breaks', async () => {
    await setup({ doc: DECK.replace(/\n/g, '\r\n') });
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Move down' }));
    expect(view.state.doc.toString()).toBe(
      '---\nmarp: true\n---\n\n## Two\n\n---\n\n# One\n\n---\n\n## Three\n',
    );
  });

  it('goes to the slide in the editor when its card is clicked', async () => {
    await setup();
    fireEvent.click(cards()[2] as HTMLElement);
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    expect(line).toBe(10); // the `---` that starts the third slide
  });

  it('starts the presentation from the first included slide and from a card', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Start presentation' }));
    expect(useMarpShow.getState()).toMatchObject({ open: true, path: 'Deck.marp', index: 0 });
    fireEvent.click(
      within(cards()[2] as HTMLElement).getByRole('button', { name: 'Start from this slide' }),
    );
    expect(useMarpShow.getState().index).toBe(2);
  });

  it('writes the settings into the frontmatter', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Presentation settings' }));
    fireEvent.click(await screen.findByLabelText('Loop at the end'));
    expect(view.state.doc.toString()).toContain('memobrain-loop: true');
    await waitFor(() => expect(screen.getByLabelText('Loop at the end')).toBeChecked());
    await waitFor(() => expect(screen.getByLabelText('Theme')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'gaia' } });
    await waitFor(() => expect(view.state.doc.toString()).toContain('theme: gaia'));
  });

  it('changes nothing when the vault is read-only', async () => {
    initI18n('en');
    installWailsMock();
    const info = await api.vault.open('/vaults/Panel');
    vaultId = info.id;
    view = new EditorView({ state: EditorState.create({ doc: DECK }) });
    registerEditor('p1', codeMirrorHandle(view, { paneId: 'p1' }));
    useMarpDeck.getState().publish({
      vaultId,
      path: 'Deck.marp',
      paneId: 'p1',
      source: DECK,
      readOnly: true,
    });
    render(<MarpSlidesPanel vaultId={vaultId} path="Deck.marp" />);
    await screen.findAllByTestId('marp-card');
    for (const name of ['Move down', 'Leave out of the presentation'])
      for (const b of screen.getAllByRole('button', { name })) expect(b).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Presentation settings' }));
    expect(screen.getByLabelText('Loop at the end')).toBeDisabled();
    expect(view.state.doc.toString()).toBe(DECK);
  });

  it('does not offer to move slides split by headings', async () => {
    await setup({ doc: '---\nmarp: true\nheadingDivider: 2\n---\n\n## A\n\n## B\n' });
    for (const b of screen.getAllByRole('button', { name: 'Move down' })) expect(b).toBeDisabled();
    expect(screen.getAllByTitle(/headingDivider/).length).toBeGreaterThan(0);
  });
});
