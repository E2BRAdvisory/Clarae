// The code that acts on "the active editor" goes through its NoteEditorHandle: bookmarks, drawings,
// the slideshow tab, the command registry and the keyboard page preview, over a real CodeMirror view.
import { history } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../app/api';
import { bookmarkBlock, hasBlockUnderCursor, headingUnderCursor } from '../bookmarks/actions';
import { commands } from '../commands/registry';
import { insertIntoActiveNote } from '../drawing/commands';
import { initI18n } from '../i18n';
import { goToSlide } from '../marp/controller';
import { useMarpDeck } from '../marp/deckStore';
import { linkUnderKeyboard } from '../preview/hover';
import { useAppStore } from '../state/store';
import { installWailsMock } from '../test/wails-mock';
import { registerEditor, setActiveEditor, unregisterEditor } from './registry';
import { codeMirrorHandle } from './source/CodeMirrorAdapter';
import type { NoteEditorHandle } from './handle';

// jsdom cannot measure text: CodeMirror's own measuring (it runs after a change) gets empty answers.
beforeAll(() => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  Range.prototype.getClientRects = () => none;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

const run = (id: string): void => void commands.find((c) => c.id === id)?.run();

let view: EditorView | null = null;
let handle: NoteEditorHandle | null = null;

function mount(doc: string, at = 0): NoteEditorHandle {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: at }, extensions: [history()] }),
  });
  handle = codeMirrorHandle(view, { paneId: 'p1' });
  registerEditor('p1', handle);
  setActiveEditor('p1');
  return handle;
}

beforeEach(async () => {
  initI18n('en');
  installWailsMock();
  useAppStore.getState().setVault(await api.vault.open('/vaults/Consumers'));
});

afterEach(() => {
  if (handle) unregisterEditor('p1', handle);
  view?.destroy();
  view = null;
  handle = null;
  useMarpDeck.getState().clear('Deck.marp');
});

describe('consumers of the active editor', () => {
  it('runs the formatting commands of the registry on it', () => {
    const doc = 'say hello now';
    const h = mount(doc);
    view?.dispatch({ selection: { anchor: 4, head: 9 } });
    run('editor:bold');
    expect(h.text()).toBe('say **hello** now');
    run('editor:heading-2');
    expect(h.text()).toBe('## say **hello** now');
    run('separator:insert');
    expect(h.text()).toBe('## say **hello** now\n\n---\n');
  });

  it('finds the heading and the block under the cursor, and gives a block an id', () => {
    useAppStore.getState().openNote('Note.md');
    const doc = '# Intro\n\ntext here\n\n## Part\nbody\n';
    const h = mount(doc, doc.indexOf('body'));
    expect(headingUnderCursor()).toBe('Part');
    expect(hasBlockUnderCursor()).toBe(true);
    bookmarkBlock();
    expect(h.text()).toMatch(/^# Intro\n\ntext here\n\n## Part\nbody \^[a-z0-9]+\n$/);
  });

  it('inserts at the cursor of the note being edited, and says when there is none', () => {
    const h = mount('before after', 'before '.length);
    expect(insertIntoActiveNote('![[Drawing.excalidraw]]')).toBe(true);
    expect(h.text()).toBe('before ![[Drawing.excalidraw]]after');
    expect(h.cursor().col).toBe('before ![[Drawing.excalidraw]]'.length + 1);
    unregisterEditor('p1', h);
    expect(insertIntoActiveNote('x')).toBe(false);
  });

  it('takes the slideshow tab to a slide (a 0-based line of the source)', () => {
    const h = mount('---\nmarp: true\n---\n\n# One\n\n---\n\n## Two\n');
    useMarpDeck.getState().publish({
      vaultId: 'v',
      path: 'Deck.marp',
      paneId: 'p1',
      source: h.text(),
      readOnly: false,
    });
    goToSlide(8);
    expect(h.cursor()).toEqual({ line: 9, col: 1 });
    goToSlide(999);
    expect(h.cursor().line).toBe(10); // the last line, which is empty
  });

  it('finds the link the keyboard would preview, with where to return the focus', () => {
    useAppStore.getState().openNote('Note.md');
    const doc = 'see [[Target#Head]] now';
    const h = mount(doc, 8);
    const rect = { left: 10, right: 60, top: 5, bottom: 21 };
    Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
    const t = linkUnderKeyboard();
    expect(t?.fromPath).toBe('Note.md');
    expect(t?.spec).toMatchObject({ target: 'Target', heading: 'Head' });
    expect(t?.anchor).toMatchObject({ top: 5, bottom: 21 });
    expect(t?.returnFocus).toBe(h.focusElement);
  });
});
