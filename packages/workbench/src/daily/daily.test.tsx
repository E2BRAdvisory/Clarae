import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createNote } from '../app/actions';
import { extractSelection, mergeActiveNote } from '../composer/actions';
import { api } from '../app/api';
import { codeMirrorHandle } from '../editor/source/CodeMirrorAdapter';
import { getActiveEditor, registerEditor, setActiveEditor } from '../editor/registry';
import { initI18n } from '../i18n';
import { fromState, unmanaged, type Managed } from '../state/managed';
import { useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { DialogHost } from '../ui/dialogs';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  listTemplates,
  newDrawingFromTemplate,
  newNoteFromTemplate,
  newPresentationFromTemplate,
  newUniqueNote,
  openAdjacentDaily,
  openDaily,
  openRandomNote,
  pickRandom,
  templateLabel,
} from './actions';
import { defaultNotesSettings, resolveNotesSettings, useNotesSettings } from './settings';

let mock: WailsMock;
let vaultId: string;
const files = () => mock.vaults.get(vaultId)?.files ?? new Map<string, string>();
const tabs = () => JSON.stringify(useAppStore.getState().layout);

beforeEach(async () => {
  initI18n('en');
  mock = installWailsMock();
  const info = await api.vault.open('/vaults/Notes');
  vaultId = info.id;
  useAppStore.getState().setVault(info);
  useNotesSettings.setState({ vaultId, user: {}, settings: { ...defaultNotesSettings } });
});

describe('settings resolution', () => {
  const managed = (config: Record<string, unknown>, locked: string[] = []): Managed =>
    fromState({
      version: 1,
      config,
      lockedKeys: locked,
      managed: true,
      fetchedAt: '',
      features: {},
    });

  it('layers defaults, managed, user and locked keys', () => {
    expect(resolveNotesSettings({}, unmanaged)).toEqual(defaultNotesSettings);
    const m = managed(
      { daily_notes: { folder: 'Journal', format: 'YYYY/MM/DD', template: 'T/D.md' } },
      ['daily_notes.format'],
    );
    const r = resolveNotesSettings(
      { dailyFolder: 'Mine', dailyFormat: 'DD-MM-YYYY', slashCommands: false },
      m,
    );
    expect(r.dailyFolder).toBe('Mine'); // managed default, not locked: the user's choice stands
    expect(r.dailyFormat).toBe('YYYY/MM/DD'); // locked
    expect(r.dailyTemplate).toBe('T/D.md');
    expect(r.slashCommands).toBe(false);
    expect(resolveNotesSettings({}, managed({ daily_notes: { folder: 5 } })).dailyFolder).toBe('');
  });
});

describe('daily notes', () => {
  it('creates today from the template and opens it, then reuses it', async () => {
    files().set('Templates/Daily.md', '# {{title}}\n{{date:YYYY}}\n');
    useNotesSettings.setState({
      settings: {
        ...defaultNotesSettings,
        dailyFolder: 'Journal',
        dailyTemplate: 'Templates/Daily.md',
      },
    });
    const path = await openDaily('2026-03-05');
    expect(path).toBe('Journal/2026-03-05.md');
    expect(files().get(path)).toBe('# 2026-03-05\n' + new Date().getFullYear() + '\n');
    expect(tabs()).toContain(path);
    files().set(path, 'edited');
    await openDaily('2026-03-05');
    expect(files().get(path)).toBe('edited');
  });

  it('navigates to the previous and next day of the active daily note', async () => {
    useNotesSettings.setState({ settings: { ...defaultNotesSettings, dailyFolder: 'Journal' } });
    await openDaily('2026-03-01');
    await openAdjacentDaily(-1);
    expect(files().has('Journal/2026-02-28.md')).toBe(true);
    expect(tabs()).toContain('Journal/2026-02-28.md');
    await openAdjacentDaily(1);
    await openAdjacentDaily(1);
    expect(files().has('Journal/2026-03-02.md')).toBe(true);
  });

  it('says so when the active note is not a daily note', async () => {
    files().set('Plain.md', 'x');
    useAppStore.getState().openNote('Plain.md');
    render(<DialogHost />);
    void openAdjacentDaily(1);
    expect(await screen.findByText(/not a daily note/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  });
});

describe('unique notes and templates', () => {
  it('creates timestamped notes without clashing', async () => {
    useNotesSettings.setState({
      settings: { ...defaultNotesSettings, uniqueFolder: 'Z', uniqueFormat: '[id]' },
    });
    const a = await newUniqueNote();
    const b = await newUniqueNote();
    expect(a).toBe('Z/id.md');
    expect(b).toBe('Z/id 2.md');
  });

  it('creates a note from a picked template', async () => {
    files().set('.clarae/templates/Meeting.md', 'Meeting {{title}}');
    files().set('.clarae/templates/Book.md', 'Book');
    // A note is created from the template of a note: the others are not offered, nor is a note
    // of the folder the templates were in up to 1.8.
    files().set('.clarae/templates/Board.excalidraw', '{}');
    files().set('.clarae/templates/Talk.marp', '# talk');
    files().set('Templates/Old.md', 'old');
    render(<DialogHost />);
    const done = newNoteFromTemplate();
    const list = await screen.findByRole('listbox', { name: 'Choose a template' });
    expect(list.querySelectorAll('button')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Meeting' }));
    const input = await screen.findByDisplayValue('Untitled');
    fireEvent.change(input, { target: { value: 'Standup' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await done;
    expect(files().get('Standup.md')).toBe('Meeting Standup');
  });

  it('applies the template for new notes to every new note', async () => {
    files().set('.clarae/templates/Note.md', '# {{title}}\n\ntags: #inbox\n');
    expect(files().get(await createNote({ name: 'Plain', open: false }))).toBe('');
    useNotesSettings.setState({
      settings: { ...defaultNotesSettings, newNoteTemplate: '.clarae/templates/Note.md' },
    });
    const path = await createNote({ name: 'Idea', open: false });
    expect(files().get(path)).toBe('# Idea\n\ntags: #inbox\n');
    // A template that disappeared leaves the note empty instead of failing.
    files().delete('.clarae/templates/Note.md');
    expect(files().get(await createNote({ name: 'Later', open: false }))).toBe('');
  });

  it('lists the templates of the vault by kind, labelled with their sub-folder', async () => {
    files().set('.clarae/templates/Work/Meeting.md', 'm');
    files().set('.clarae/templates/Board.excalidraw', '{}');
    files().set('.clarae/templates/Talk.marp', '# talk');
    files().set('.clarae/templates/logo.png', 'png');
    files().set('.clarae/editor.json', '{}');
    expect((await listTemplates('note')).map((t) => [t.ref, templateLabel(t)])).toEqual([
      ['.clarae/templates/Work/Meeting.md', 'Meeting (Work)'],
    ]);
    expect((await listTemplates('drawing')).map(templateLabel)).toEqual(['Board']);
    expect((await listTemplates('presentation')).map(templateLabel)).toEqual(['Talk']);
    expect(
      templateLabel({ name: 'Shared', rel: 'a/Shared.md', source: 'library', library: 'Team' }),
    ).toBe('Shared (Team)');
  });

  it('keeps the keys the core writes to the settings file when a setting is saved', async () => {
    files().set(
      '.clarae/daily.json',
      JSON.stringify({
        templatesFolder: 'Models',
        templatesMigrated: true,
        templatesMigratedFrom: 'Models',
      }),
    );
    await useNotesSettings.getState().load(vaultId);
    useNotesSettings.getState().set({ dailyFolder: 'Journal' });
    await waitFor(() =>
      expect(JSON.parse(files().get('.clarae/daily.json') ?? '{}')).toEqual({
        templatesFolder: 'Models',
        templatesMigrated: true,
        templatesMigratedFrom: 'Models',
        dailyFolder: 'Journal',
      }),
    );
  });

  it('tells when there are no templates', async () => {
    render(<DialogHost />);
    void newNoteFromTemplate();
    expect(await screen.findByText(/no templates of this kind yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  });
});

describe('drawings and presentations from templates', () => {
  const scene = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
    appState: {},
    files: {},
  });
  const created = (ext: string): string[] =>
    [...files().keys()].filter((p) => p.endsWith(ext) && !p.startsWith('.clarae/'));

  it('starts every new drawing and presentation from the template of the settings', async () => {
    const { newDrawing } = await import('../drawing/commands');
    const { newPresentation } = await import('../marp/commands');
    files().set('.clarae/templates/Board.excalidraw', scene);
    files().set('.clarae/templates/Talk.marp', '---\nmarp: true\n---\n\n# {{title}}\n');
    // Without a choice: the built-in first content.
    expect(files().get(await newDrawing({ dir: 'A' }))).not.toBe(scene);
    expect(files().get(await newPresentation({ dir: 'A' }))).toContain('theme: default');
    useNotesSettings.setState({
      settings: {
        ...defaultNotesSettings,
        newDrawingTemplate: '.clarae/templates/Board.excalidraw',
        newPresentationTemplate: '.clarae/templates/Talk.marp',
      },
    });
    expect(files().get(await newDrawing({ dir: 'B' }))).toBe(scene);
    const deck = await newPresentation({ dir: 'B' });
    expect(files().get(deck)).toMatch(/^---\nmarp: true\n---\n\n# Presentation /);
    // A template that is gone, or is not a drawing, never fails the creation.
    files().set('.clarae/templates/Board.excalidraw', '# not a drawing');
    files().delete('.clarae/templates/Talk.marp');
    expect(files().get(await newDrawing({ dir: 'C' }))).not.toBe('# not a drawing');
    expect(files().get(await newPresentation({ dir: 'C' }))).toContain('theme: default');
  });

  it('creates a drawing and a presentation from a picked template', async () => {
    files().set('.clarae/templates/Board.excalidraw', scene);
    files().set('.clarae/templates/Talk.marp', '# from the template\n');
    files().set('.clarae/templates/Note.md', 'a note');
    render(<DialogHost />);
    let done = newDrawingFromTemplate();
    let list = await screen.findByRole('listbox', { name: 'Choose a template' });
    expect(list.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    await done;
    expect(created('.excalidraw').map((p) => files().get(p))).toEqual([scene]);

    done = newPresentationFromTemplate();
    list = await screen.findByRole('listbox', { name: 'Choose a template' });
    expect(list.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Talk' }));
    await done;
    expect(created('.marp').map((p) => files().get(p))).toEqual(['# from the template\n']);
  });

  it('never creates next to a template that is open in a tab', async () => {
    const { newDrawing } = await import('../drawing/commands');
    files().set('.clarae/templates/Note.md', 'a note');
    useAppStore.getState().openNote('.clarae/templates/Note.md');
    expect(await newDrawing()).not.toMatch(/^\.clarae\//);
    expect(await createNote({ name: 'Idea', open: false })).toBe('Idea.md');
  });
});

describe('random note', () => {
  it('is uniform and never the current note', () => {
    expect(pickRandom([], null)).toBeUndefined();
    expect(pickRandom(['a'], 'a')).toBeUndefined();
    const items = ['a', 'b', 'c', 'd'];
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add(pickRandom(items, 'b', () => i / 4) ?? '');
    expect(seen).toEqual(new Set(['a', 'c', 'd']));
    expect(pickRandom(items, null, () => 0.999999)).toBe('d');
  });

  it('opens another note of the vault', async () => {
    files().set('A.md', 'a');
    files().set('B.md', 'b');
    files().set('.trash/C.md', 'c');
    useAppStore.getState().openNote('A.md');
    await openRandomNote();
    const active = JSON.stringify(useAppStore.getState().layout);
    expect(active).toContain('B.md');
    expect(active).not.toContain('C.md');
  });
});

describe('note composer', () => {
  it('merges the active note into another, redirects links and removes the source', async () => {
    files().set('A.md', 'target');
    files().set('B.md', 'source body');
    files().set('C.md', 'see [[B]] and [[B#x]]');
    useAppStore.getState().openNote('B.md');
    render(<DialogHost />);
    const done = mergeActiveNote();
    await screen.findByRole('listbox', { name: /Merge "B" into/ });
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(await screen.findByText(/redirect 2 links in 1 notes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await done;
    expect(files().get('A.md')).toBe('target\n\n## B\n\nsource body\n');
    expect(files().get('C.md')).toBe('see [[A]] and [[A#x]]');
    expect(files().has('B.md')).toBe(false);
    expect(tabs()).toContain('A.md');
    expect(tabs()).not.toContain('"B.md"');
  });

  it('extracts the selection into a new note and leaves a link', async () => {
    files().set('Notes/Src.md', 'before\n# Plan\nsteps\nafter');
    useAppStore.getState().openNote('Notes/Src.md');
    const doc = 'before\n# Plan\nsteps\nafter';
    const view = new EditorView({
      state: EditorState.create({ doc, selection: { anchor: 7, head: 19 } }),
      parent: document.body,
    });
    const handle = codeMirrorHandle(view, { paneId: 'p1' });
    registerEditor('p1', handle);
    setActiveEditor('p1');
    expect(getActiveEditor()).toBe(handle);
    render(<DialogHost />);
    const done = extractSelection();
    await screen.findByDisplayValue('Plan');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(files().has('Notes/Plan.md')).toBe(true));
    await done;
    expect(files().get('Notes/Plan.md')).toBe('# Plan\nsteps\n');
    expect(view.state.doc.toString()).toBe('before\n[[Plan]]\nafter');
    view.destroy();
  });
});
