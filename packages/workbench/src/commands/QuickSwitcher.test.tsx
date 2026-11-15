import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type Suggestion, type VaultInfo } from '../app/api';
import { installOpenFile } from '../app/openFile';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useSettings } from '../state/settings';
import { setOpenInterceptor, useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { allPanes, emptyLayout } from '../workspace/layout';
import { canCreateNote, optionLabel, QuickSwitcher, switcherKind } from './QuickSwitcher';

const CANVAS = '{"nodes":[],"edges":[]}';
const APP = `${JSON.stringify({ version: 1, url: 'https://status.example.com/' })}\n`;

let mock: WailsMock;
let vault: VaultInfo;

const sug = (kind: string, path: string, label = path): Suggestion => ({
  kind,
  label,
  path,
  detail: '',
  line: 0,
  score: 1,
});

async function setup(files: Record<string, string>): Promise<void> {
  initI18n('en');
  mock = installWailsMock();
  configurePlatform();
  useSettings.getState().reset();
  vault = await api.vault.open('/vaults/Demo');
  const v = mock.vaults.get(vault.id);
  for (const [p, c] of Object.entries(files)) v?.files.set(p, c);
  useAppStore.setState({ layout: emptyLayout(), switcherOpen: true });
  useAppStore.getState().setVault(vault);
  installOpenFile();
}

const search = async (q: string): Promise<void> => {
  fireEvent.change(await screen.findByRole('combobox', { name: 'Find a file or create a note…' }), {
    target: { value: q },
  });
};

/** Opens the switcher again, as the hotkey does. */
const reopen = (): void => {
  act(() => useAppStore.getState().setSwitcherOpen(true));
};

const openTabs = (): string[] =>
  allPanes(useAppStore.getState().layout.root).flatMap((p) => p.tabs.map((t) => t.path));

beforeEach(() => {
  setOpenInterceptor(null);
});
afterEach(() => {
  cleanup();
  setOpenInterceptor(null);
});

describe('QuickSwitcher', () => {
  const FILES = {
    'Notes/Road trip.md': '# Road trip\n',
    'Decks/Roadshow.marp': '---\nmarp: true\n---\n# Slide\n',
    'Apps/Road status.webapp': APP,
    'Boards/Road board.canvas': CANVAS,
    'Views/Road view.base': 'views: []\n',
    'Draw/Road sketch.excalidraw': '{"type":"excalidraw","version":2,"elements":[]}',
    'Road.txt': 'not openable here',
    'Road.zip': 'not openable here',
  };

  it('lists applications, canvases, bases and drawings with their kind in words', async () => {
    await setup(FILES);
    render(<QuickSwitcher />);
    await search('road');
    const list = await screen.findByRole('listbox');
    await within(list).findByRole('option', { name: /Road status, Application/ });
    // the name of each option says what it is, besides the icon (which is hidden from assistive technology)
    for (const name of [
      /Road trip, Note/,
      /Roadshow, Presentation/,
      /Road board, Canvas/,
      /Road view, Base/,
      /Road sketch, Drawing/,
    ])
      expect(within(list).getByRole('option', { name })).toBeInTheDocument();
    // the folder is the secondary text, and a file the app cannot show is not listed
    expect(within(list).getByRole('option', { name: /Road status/ })).toHaveTextContent('Apps');
    expect(within(list).queryByText(/Road\.txt|Road\.zip|^Road$/)).toBeNull();
    // six files, the heading of the note and the creation of a note named "road"
    expect(within(list).getAllByRole('option')).toHaveLength(8);
    expect(within(list).getByRole('option', { name: /Road trip, Heading/ })).toBeInTheDocument();
    // each row has the icon of its kind, as in the file explorer
    expect(
      within(list)
        .getByRole('option', { name: /Road status/ })
        .querySelector('svg'),
    ).not.toBeNull();
  });

  it('opens an application in the tab of the application, not with the system', async () => {
    await setup(FILES);
    render(<QuickSwitcher />);
    await search('status');
    const option = await screen.findByRole('option', { name: /Road status, Application/ });
    fireEvent.click(option);
    expect(openTabs()).toEqual(['Apps/Road status.webapp']);
    expect(mock.systemOpens).toEqual([]);
    expect(useAppStore.getState().switcherOpen).toBe(false);
  });

  it('opens a canvas, a base and a drawing in tabs, a new tab with Mod-Enter', async () => {
    await setup(FILES);
    render(<QuickSwitcher />);
    await search('board');
    fireEvent.keyDown(await screen.findByRole('combobox'), { key: 'Enter' });
    expect(openTabs()).toEqual(['Boards/Road board.canvas']);

    reopen();
    await search('view');
    await screen.findByRole('option', { name: /Road view, Base/ });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', ctrlKey: true });
    expect(openTabs()).toEqual(['Boards/Road board.canvas', 'Views/Road view.base']);

    reopen();
    await search('sketch');
    fireEvent.click(await screen.findByRole('option', { name: /Road sketch, Drawing/ }));
    expect(openTabs()).toContain('Draw/Road sketch.excalidraw');
    expect(mock.systemOpens).toEqual([]);
  });

  it('still offers to create a note when only a file of another kind has that name', async () => {
    await setup({ ...FILES, 'Road.canvas': CANVAS, 'Road.webapp': APP });
    render(<QuickSwitcher />);
    await search('Road');
    await screen.findByRole('option', { name: /Road, Canvas/ });
    await screen.findByRole('option', { name: /Road, Application/ });
    // the whiteboard and the application do not take away the way to create the note
    fireEvent.click(await screen.findByText('Create "Road"'));
    await waitFor(() => expect(mock.vaults.get(vault.id)?.files.has('Road.md')).toBe(true));
    expect(openTabs()).toEqual(['Road.md']);
  });

  it('does not offer to create a note named like a presentation', async () => {
    await setup({ 'Deck/Road.marp': '---\nmarp: true\n---\n# Slide\n' });
    render(<QuickSwitcher />);
    await search('Road');
    await screen.findByRole('option', { name: /Road, Presentation/ });
    expect(screen.queryByText('Create "Road"')).toBeNull();
  });

  it('does not offer to create a note that exists', async () => {
    await setup({ 'Road.md': '# Road\n', 'Road.canvas': CANVAS });
    render(<QuickSwitcher />);
    await search('Road');
    await screen.findByRole('option', { name: /Road, Note/ });
    await screen.findByRole('option', { name: /Road, Canvas/ });
    expect(screen.queryByText('Create "Road"')).toBeNull();
  });

  it('shows the notes and the other files when nothing is typed, within the limit', async () => {
    await setup({ ...FILES, 'Zed.md': '# Zed\n' });
    render(<QuickSwitcher />);
    const list = await screen.findByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(5));
    // no creation with an empty query; the files that cannot be opened here stay out
    expect(within(list).queryByText(/Create/)).toBeNull();
    expect(within(list).queryByText(/Road\.txt|Road\.zip/)).toBeNull();
    // one list for everything, in the order of the core (name), not the notes first
    const labels = within(list)
      .getAllByRole('option')
      .map((o) => o.querySelector('.label')?.firstChild?.textContent);
    expect(labels).toEqual([...labels].sort((a, b) => (a ?? '').localeCompare(b ?? '')));
  });
});

describe('the mock of Suggest, as the core answers the switcher', () => {
  it('gives the kinds of the core, by extension in any case, and only for "all"', async () => {
    await setup({
      'A.md': '# A\n',
      'Deck.marp': '# d\n',
      'Dir/App.WEBAPP': APP,
      'Board.canvas': CANVAS,
      'View.base': 'views: []\n',
      'Sketch.excalidraw': '{}',
      'notes.txt': 'x',
      webapp: 'a file without extension',
      '.canvas': 'a hidden file, not a canvas named ""',
      'Other.webapp.bak': 'no',
    });
    const all = await api.links.suggest(vault.id, 'all', '', '', 50);
    const kinds = Object.fromEntries(all.map((s) => [s.path, s.kind]));
    expect(kinds).toEqual({
      'A.md': 'note',
      'Deck.marp': 'note',
      'Dir/App.WEBAPP': 'webapp',
      'Board.canvas': 'canvas',
      'View.base': 'base',
      'Sketch.excalidraw': 'drawing',
    });
    expect(all.find((s) => s.path === 'Dir/App.WEBAPP')).toMatchObject({
      label: 'App',
      detail: 'Dir',
    });
    // the completion of a wikilink never sees the other kinds
    const notes = await api.links.suggest(vault.id, 'notes', '', '', 50);
    expect(notes.every((s) => s.kind === 'note' || s.kind === 'alias')).toBe(true);
    expect(notes.map((s) => s.path)).not.toContain('Dir/App.WEBAPP');
  });
});

describe('the mock of Suggest and the hidden files', () => {
  it('lists nothing of the trash or of a hidden folder in the switcher', async () => {
    await setup({
      'Road.md': '# Road\n## Hidden heading road\n',
      '.trash/Road old.md': '# Road old\n',
      '.trash/Road old.canvas': CANVAS,
      '.git/Road.base': 'views: []\n',
      'Docs/.cache/Road.webapp': APP,
      'Docs/Road.canvas': CANVAS,
    });
    const paths = async (q: string): Promise<string[]> =>
      (await api.links.suggest(vault.id, 'all', q, '', 50)).map((s) => s.path).sort();
    // the note (with its two headings that match) and the canvas, nothing from .trash, .git, .cache
    expect(new Set(await paths('road'))).toEqual(new Set(['Docs/Road.canvas', 'Road.md']));
    expect(await paths('')).toEqual(['Docs/Road.canvas', 'Road.md']);
  });
});

describe('what the switcher says about a suggestion', () => {
  it('names the kind of a note, a presentation and the files of the other kinds', () => {
    expect(switcherKind(sug('note', 'A.md'))).toBe('note');
    expect(switcherKind(sug('note', 'Deck.marp'))).toBe('presentation');
    expect(switcherKind(sug('webapp', 'A.webapp'))).toBe('webapp');
    expect(switcherKind(sug('alias', 'A.md'))).toBe('alias');
    expect(switcherKind(sug('heading', 'A.md'))).toBe('heading');
  });

  it('reads the name, the kind and the folder of an option, and not the level of a heading', () => {
    expect(
      optionLabel({ ...sug('webapp', 'Apps/Docs.webapp', 'Docs'), detail: 'Apps' }, 'Application'),
    ).toBe('Docs, Application, Apps');
    expect(optionLabel(sug('canvas', 'Docs.canvas', 'Docs'), 'Canvas')).toBe('Docs, Canvas');
    expect(optionLabel({ ...sug('heading', 'A.md', 'Intro'), detail: '##' }, 'Heading')).toBe(
      'Intro, Heading',
    );
  });

  it('counts a note, an alias or a presentation as having the name, and no other file', () => {
    const named = (kind: string, path: string) => [sug(kind, path, 'Road')];
    expect(canCreateNote('', [])).toBe(false);
    expect(canCreateNote('  ', [])).toBe(false);
    expect(canCreateNote('Road', [])).toBe(true);
    expect(canCreateNote('road', named('note', 'Road.md'))).toBe(false);
    expect(canCreateNote('ROAD', named('alias', 'Other.md'))).toBe(false);
    // a link [[Road]] resolves to a presentation (or to an alias of one) as to a note: creating
    // Road.md would take those links away from it
    expect(canCreateNote('Road', named('note', 'Deck/Road.marp'))).toBe(false);
    expect(canCreateNote('Trip', [sug('alias', 'Deck/Road.marp', 'Trip')])).toBe(false);
    for (const [kind, path] of [
      ['webapp', 'Road.webapp'],
      ['canvas', 'Road.canvas'],
      ['base', 'Road.base'],
      ['drawing', 'Road.excalidraw'],
      ['heading', 'Other.md'],
    ] as const)
      expect(canCreateNote('Road', named(kind, path))).toBe(true);
  });
});
