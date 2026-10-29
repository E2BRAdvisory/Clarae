import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  insertLink,
  insertSeparator,
  insertWikilink,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleQuote,
  toggleTask,
} from './commands';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function make(doc: string, from: number, to = from): EditorView {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(from, to),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    }),
    parent: document.body,
  });
  return view;
}
const text = (v: EditorView): string => v.state.doc.toString();
const sel = (v: EditorView): [number, number] => [
  v.state.selection.main.from,
  v.state.selection.main.to,
];

describe('formatting commands', () => {
  it('wraps and unwraps a selection', () => {
    const v = make('hello world', 0, 5);
    toggleBold(v);
    expect(text(v)).toBe('**hello** world');
    expect(sel(v)).toEqual([2, 7]);
    toggleBold(v); // selection is the inner text: unwrap
    expect(text(v)).toBe('hello world');
    expect(sel(v)).toEqual([0, 5]);
  });

  it('inserts a pair around the caret when nothing is selected', () => {
    const v = make('ab', 1);
    toggleHighlight(v);
    expect(text(v)).toBe('a====b');
    expect(sel(v)).toEqual([3, 3]);
  });

  it('unwraps when the selection includes the markers', () => {
    const v = make('x **bold** y', 2, 10);
    toggleBold(v);
    expect(text(v)).toBe('x bold y');
  });

  it('turns a selection into a Markdown link with the url selected', () => {
    const v = make('see here now', 4, 8);
    insertLink(v);
    expect(text(v)).toBe('see [here](url) now');
    expect(text(v).slice(...sel(v))).toBe('url');
  });

  it('inserts a wikilink around the selection or empty', () => {
    const v = make('a Note b', 2, 6);
    insertWikilink(v);
    expect(text(v)).toBe('a [[Note]] b');
    const w = make('', 0);
    insertWikilink(w);
    expect(text(w)).toBe('[[]]');
    expect(sel(w)).toEqual([2, 2]);
  });

  it('sets, changes and removes heading levels on every selected line', () => {
    const v = make('one\ntwo', 0, 7);
    setHeading(2)(v);
    expect(text(v)).toBe('## one\n## two');
    setHeading(3)(v);
    expect(text(v)).toBe('### one\n### two');
    setHeading(3)(v);
    expect(text(v)).toBe('one\ntwo');
  });

  it('toggles bullet lists and quotes', () => {
    const v = make('a\nb', 0, 3);
    toggleBulletList(v);
    expect(text(v)).toBe('- a\n- b');
    toggleBulletList(v);
    expect(text(v)).toBe('a\nb');
    toggleQuote(v);
    expect(text(v)).toBe('> a\n> b');
  });

  it('cycles a task: text -> bullet -> open -> done -> bullet-less', () => {
    const v = make('call Alice', 0);
    toggleTask(v);
    expect(text(v)).toBe('- [ ] call Alice');
    toggleTask(v);
    expect(text(v)).toBe('- [x] call Alice');
    toggleTask(v);
    expect(text(v)).toBe('- call Alice');
    toggleTask(v);
    expect(text(v)).toBe('- [ ] call Alice');
  });
});

describe('insertSeparator', () => {
  it('goes below the current line with a blank line before it', () => {
    const v = make('Title\nBody', 2);
    insertSeparator(v);
    expect(v.state.doc.toString()).toBe('Title\n\n---\n\nBody');
  });

  it('uses an empty line as is, so the rule never turns text into a heading', () => {
    const v = make('Text\n\nMore', 5);
    insertSeparator(v);
    expect(v.state.doc.toString()).toBe('Text\n\n---\n\nMore');
  });

  it('never opens a frontmatter block on the first line', () => {
    const v = make('', 0);
    insertSeparator(v);
    expect(v.state.doc.toString().startsWith('---')).toBe(false);
  });
});
