import { describe, expect, it } from 'vitest';
import { history, redo, undo } from '@codemirror/commands';
import { EditorState, type Transaction } from '@codemirror/state';
import { External, externalReplace } from './external';

/** A minimal stand-in for an EditorView: commands dispatch into `state`. */
function editor(doc: string) {
  const box = { state: EditorState.create({ doc, extensions: [history()] }) };
  const dispatch = (tr: Transaction): void => {
    box.state = tr.state;
  };
  return {
    get doc() {
      return box.state.doc.toString();
    },
    type(at: number, text: string) {
      box.state = box.state.update({
        changes: { from: at, insert: text },
        userEvent: 'input',
      }).state;
    },
    external(text: string) {
      const spec = externalReplace(box.state, text);
      if (spec) box.state = box.state.update(spec).state;
      return spec;
    },
    undo: () => undo({ state: box.state, dispatch }),
    redo: () => redo({ state: box.state, dispatch }),
    get head() {
      return box.state.selection.main.head;
    },
    select(pos: number) {
      box.state = box.state.update({ selection: { anchor: pos } }).state;
    },
  };
}

describe('externalReplace', () => {
  it('keeps a change that arrived from outside when the user presses Undo', () => {
    const ed = editor('hello');
    ed.type(5, ' world');
    // A colleague's edit arrives through the sync: the note now starts with "HEY ".
    ed.external('HEY hello world');
    expect(ed.doc).toBe('HEY hello world');
    // Undo reverts the user's own typing only, mapped over the change that arrived.
    expect(ed.undo()).toBe(true);
    expect(ed.doc).toBe('HEY hello');
    expect(ed.undo()).toBe(false);
    expect(ed.doc).toBe('HEY hello');
    expect(ed.redo()).toBe(true);
    expect(ed.doc).toBe('HEY hello world');
  });

  it('does not bring back edits discarded by a reload', () => {
    const ed = editor('abc');
    ed.type(3, 'mine');
    ed.external('abc'); // "Reload" in the conflict banner: the file's text wins
    expect(ed.doc).toBe('abc');
    ed.undo();
    expect(ed.doc).toBe('abc');
  });

  it('replaces only the span that differs and maps the selection over it', () => {
    const ed = editor('one two three');
    ed.select(13); // end of "three"
    const spec = ed.external('one 2 three');
    expect(spec?.changes).toEqual({ from: 4, to: 7, insert: '2' });
    expect(spec?.annotations).toContainEqual(External.of(true));
    expect(ed.head).toBe(11);
  });

  it('is null when the text is already the same', () => {
    const ed = editor('same');
    expect(ed.external('same')).toBeNull();
  });

  it('handles texts that share a prefix and a suffix around a deletion', () => {
    const ed = editor('aaaa');
    ed.external('aa');
    expect(ed.doc).toBe('aa');
    ed.external('aaaaaa');
    expect(ed.doc).toBe('aaaaaa');
    ed.external('');
    expect(ed.doc).toBe('');
  });
});
