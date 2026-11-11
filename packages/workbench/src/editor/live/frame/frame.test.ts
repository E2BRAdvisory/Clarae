// The frame of the Live editor (A-W5c) on the mounted Milkdown editor: find and replace, folding, and
// the settings that follow the application while the editor is open.
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../../i18n';
import type { LiveEditor } from '../MilkdownAdapter';
import { posAfter } from '../testing/helpers';
import { DEFAULT_LIVE_SETTINGS, type LiveSettings } from './index';
import {
  expandReplacement,
  findKey,
  findMatches,
  findNext,
  findStateOf,
  replaceAll,
  replaceCurrent,
  setFind,
} from './find';
import {
  foldAll,
  foldCode,
  foldableAt,
  foldKey,
  foldStateOf,
  toggleFoldAt,
  unfoldAll,
} from './fold';
import { EditorViewOf, openLive } from '../testing/mounted';

vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => initI18n('en'));

const opened: { dispose(): void }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.dispose();
  document.body.replaceChildren();
});

interface Ed {
  editor: LiveEditor;
  view: EditorView;
  parent: HTMLElement;
  changes: ReturnType<typeof vi.fn>;
  /** The caret just after the first occurrence of `text`. */
  caretAfter(text: string): void;
  search(patch: Parameters<typeof setFind>[1]['query'], open?: boolean): void;
}

async function open(raw: string, settings: Partial<LiveSettings> = {}): Promise<Ed> {
  const changes = vi.fn();
  const live = await openLive(raw, {
    settings: { ...DEFAULT_LIVE_SETTINGS, spellcheck: false, ...settings },
    onChange: changes,
  });
  opened.push(live);
  const view = EditorViewOf(live.editor);
  return {
    editor: live.editor,
    view,
    parent: live.parent,
    changes,
    caretAfter: (text) => {
      const at = posAfter(view.state.doc, text);
      expect(at).toBeGreaterThan(0);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    },
    search: (patch, openIt = true) => setFind(view, { open: openIt, query: patch ?? {} }),
  };
}

const NOTE = [
  '# Alpha',
  '',
  'one fox and **another Fox** here',
  '',
  '## Beta',
  '',
  'the fox again',
  '',
  '# Gamma',
  '',
  'last paragraph',
  '',
].join('\n');

describe('find', () => {
  it('finds the text the user reads, in every block, without regard to case by default', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'fox' });
    const s = findStateOf(ed.view.state);
    expect(s?.matches).toHaveLength(3);
    expect(ed.parent.querySelectorAll('.live-find-match')).toHaveLength(3);
    // marks are not in the way: "another Fox" is found inside the bold text
    ed.search({ search: 'ANOTHER fox' });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(1);
  });

  it('looks for the rendered text, not for the Markdown that writes it', async () => {
    const ed = await open(NOTE);
    ed.search({ search: '**' });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(0);
    ed.search({ search: '#' });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(0);
  });

  it('matches the case when asked to', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'Fox', caseSensitive: true });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(1);
    ed.search({ caseSensitive: false });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(3);
  });

  it('takes a regular expression, and flags one that does not compile', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'f(o)x', regex: true });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(3);
    ed.search({ search: 'f(o', regex: true });
    const s = findStateOf(ed.view.state);
    expect(s?.invalid).toBe(true);
    expect(s?.matches).toEqual([]);
    // the same text is plain text when the option is off
    ed.search({ search: 'f(o', regex: false });
    expect(findStateOf(ed.view.state)?.invalid).toBe(false);
  });

  it('does not keep empty matches nor loop on them', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'x*', regex: true });
    // `x*` matches the empty string everywhere and the x of every fox
    expect(findStateOf(ed.view.state)?.matches.every((m) => m.to > m.from)).toBe(true);
  });

  it('goes to the next and the previous match, round the document', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'fox' });
    const sel = () =>
      ed.view.state.doc.textBetween(ed.view.state.selection.from, ed.view.state.selection.to);
    const index = findNext(ed.view, 1);
    expect(index).toBe(0);
    expect(sel().toLowerCase()).toBe('fox');
    expect(findStateOf(ed.view.state)?.current).toBe(0);
    expect(findNext(ed.view, 1)).toBe(1);
    expect(findNext(ed.view, 1)).toBe(2);
    expect(findNext(ed.view, 1)).toBe(0); // wraps
    expect(findNext(ed.view, -1)).toBe(2); // and back
    expect(findNext(ed.view, -1)).toBe(1);
  });

  it('replaces the selected match and goes on to the next', async () => {
    const ed = await open('a cat, a cat, a cat\n');
    ed.search({ search: 'cat', replace: 'dog' });
    // nothing is selected yet: the first press shows the match
    expect(replaceCurrent(ed.view)).toBe(false);
    expect(ed.editor.text()).toBe('a cat, a cat, a cat\n');
    expect(replaceCurrent(ed.view)).toBe(true);
    expect(ed.editor.text()).toBe('a dog, a cat, a cat\n');
    expect(replaceCurrent(ed.view)).toBe(true);
    expect(ed.editor.text()).toBe('a dog, a dog, a cat\n');
    expect(ed.editor.edited).toBe(true);
  });

  it('replaces all the matches as one step of the history', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'fox', replace: 'owl' });
    expect(replaceAll(ed.view)).toBe(3);
    const text = ed.editor.text();
    expect(text).toContain('one owl and **another owl** here');
    expect(text).toContain('the owl again');
    expect(text).not.toMatch(/fox/i);
    // the marks and the rest of the note are the file's own
    expect(text).toContain('## Beta');
    expect(ed.editor.exec('undo')).toBe(true);
    expect(ed.editor.text()).toBe(NOTE);
  });

  it('writes a replacement with captures and leaves `$` alone in a plain search', async () => {
    const ed = await open('2024-05-17 and 2023-01-02\n');
    ed.search({ search: '(\\d+)-(\\d+)-(\\d+)', regex: true, replace: '$3/$2/$1 ($&)' });
    replaceAll(ed.view);
    expect(ed.editor.text()).toBe('17/05/2024 (2024-05-17) and 02/01/2023 (2023-01-02)\n');
    const plain = await open('cost: x\n');
    plain.search({ search: 'x', replace: '$1 $&', regex: false });
    replaceAll(plain.view);
    // the layer writes a `$` the way it writes any typed one (it may escape it); nothing is expanded
    expect(plain.editor.text()).toMatch(/^cost: \\?\$1 \\?\$&\n$/);
  });

  it('expands a replacement the way String.replace does', () => {
    const m = /(?<y>\d+)-(\d+)/g.exec('on 2024-05') as RegExpExecArray;
    expect(expandReplacement('$<y>|$2|$1|$&|$$|$9|$<nope>', m)).toBe(
      '2024|05|2024|2024-05|$|$9|$<nope>',
    );
  });

  it('never replaces in a read-only editor', async () => {
    const ed = await open('a cat\n');
    ed.search({ search: 'cat', replace: 'dog' });
    ed.editor.setReadOnly(true);
    replaceAll(ed.view);
    expect(ed.editor.text()).toBe('a cat\n');
    expect(ed.changes).not.toHaveBeenCalled();
  });

  it('keeps its matches in step with the edits of the document', async () => {
    const ed = await open('fox\n');
    ed.search({ search: 'fox' });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(1);
    const at = posAfter(ed.view.state.doc, 'fox');
    ed.view.dispatch(ed.view.state.tr.insertText(' fox', at));
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(2);
  });

  it('is not offered a match that crosses a node that is not text', async () => {
    const ed = await open('see ![](a.png) end\n');
    ed.search({ search: 'see end' });
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(0);
    ed.search({ search: '.', regex: true });
    const doc = ed.view.state.doc;
    for (const m of findStateOf(ed.view.state)?.matches ?? []) {
      expect(doc.textBetween(m.from, m.to, '\u0000', '\u0000')).not.toContain('\u0000');
    }
  });

  it('closing the search clears the marks and the matches', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'fox' });
    expect(ed.parent.querySelectorAll('.live-find-match').length).toBeGreaterThan(0);
    setFind(ed.view, { open: false });
    expect(ed.parent.querySelectorAll('.live-find-match')).toHaveLength(0);
    expect(findKey.getState(ed.view.state)?.matches).toEqual([]);
  });

  it('searches the code blocks too, and marks the block that holds a match', async () => {
    const ed = await open('text\n\n```js\nconst fox = 1;\n```\n');
    const doc = ed.view.state.doc;
    expect(
      findMatches(doc, { search: 'fox', caseSensitive: false, regex: false, replace: '' }).matches,
    ).toHaveLength(1);
    ed.search({ search: 'fox' });
    expect(ed.parent.querySelectorAll('.live-find-block')).toHaveLength(1);
  });
});

describe('the find bar', () => {
  const bar = (ed: Ed) => ed.parent.querySelector('.live-find') as HTMLElement;
  const input = (ed: Ed, label: string) =>
    bar(ed).querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  const type = (el: HTMLInputElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const press = (el: Element, key: string, init: KeyboardEventInit = {}): void => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  };

  it('is hidden until opened, then takes the keyboard and shows a count the user hears', async () => {
    const ed = await open(NOTE);
    expect(bar(ed).hidden).toBe(true);
    ed.editor.openSearch();
    expect(bar(ed).hidden).toBe(false);
    expect(bar(ed).getAttribute('role')).toBe('search');
    expect(document.activeElement).toBe(input(ed, 'Find'));
    type(input(ed, 'Find'), 'fox');
    const status = bar(ed).querySelector('[role=status]') as HTMLElement;
    expect(status.textContent).toBe('3 matches');
    expect(status.getAttribute('aria-live')).toBe('polite');
    press(input(ed, 'Find'), 'Enter');
    expect(status.textContent).toBe('1 of 3');
    press(input(ed, 'Find'), 'Enter', { shiftKey: true });
    expect(status.textContent).toBe('3 of 3');
  });

  it('has a translated, named control for every function', async () => {
    const ed = await open(NOTE);
    ed.editor.openSearch();
    const names = [...bar(ed).querySelectorAll('button, input')].map((e) =>
      e.getAttribute('aria-label'),
    );
    expect(names).toEqual([
      'Find',
      'Match case',
      'Regular expression',
      'Previous match',
      'Next match',
      'Close find',
      'Replace with',
      'Replace',
      'Replace all',
    ]);
    expect(bar(ed).querySelectorAll('button[aria-pressed]')).toHaveLength(2);
  });

  it('seeds the search with the selected text', async () => {
    const ed = await open(NOTE);
    const from = posAfter(ed.view.state.doc, 'one ') - 0;
    ed.view.dispatch(
      ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, from, from + 3)),
    );
    ed.editor.openSearch();
    expect(input(ed, 'Find').value).toBe('fox');
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(3);
  });

  it('toggles match case and regular expression, and says when an expression is invalid', async () => {
    const ed = await open(NOTE);
    ed.editor.openSearch();
    type(input(ed, 'Find'), 'Fox');
    const toggle = (name: string) =>
      bar(ed).querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;
    toggle('Match case').click();
    expect(toggle('Match case').getAttribute('aria-pressed')).toBe('true');
    expect(findStateOf(ed.view.state)?.matches).toHaveLength(1);
    toggle('Regular expression').click();
    type(input(ed, 'Find'), 'f(o');
    expect(input(ed, 'Find').getAttribute('aria-invalid')).toBe('true');
    expect((bar(ed).querySelector('[role=status]') as HTMLElement).textContent).toBe(
      'Invalid regular expression',
    );
  });

  it('replaces from its own fields, and a read-only editor cannot', async () => {
    const ed = await open('one fox, two fox\n');
    ed.editor.openSearch();
    type(input(ed, 'Find'), 'fox');
    type(input(ed, 'Replace with'), 'owl');
    (bar(ed).querySelector('button[aria-label="Replace all"]') as HTMLButtonElement).click();
    expect(ed.editor.text()).toBe('one owl, two owl\n');
    ed.editor.exec('undo');
    ed.editor.setReadOnly(true);
    const all = bar(ed).querySelector('button[aria-label="Replace all"]') as HTMLButtonElement;
    expect(all.disabled).toBe(true);
    expect(input(ed, 'Replace with').disabled).toBe(true);
  });

  it('closes with Escape, clears the marks and gives the keyboard back to the document', async () => {
    const ed = await open(NOTE);
    ed.editor.openSearch();
    type(input(ed, 'Find'), 'fox');
    press(input(ed, 'Find'), 'Escape');
    expect(bar(ed).hidden).toBe(true);
    expect(ed.parent.querySelectorAll('.live-find-match')).toHaveLength(0);
    expect(ed.parent.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(ed.view.dom);
  });

  it('keeps the application hotkeys out of its fields', async () => {
    const hotkey = vi.fn(() => true);
    const live = await openLive(NOTE, { hotkey: () => hotkey });
    opened.push(live);
    live.editor.openSearch();
    const field = live.parent.querySelector('input[aria-label="Find"]') as HTMLInputElement;
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(hotkey).not.toHaveBeenCalled();
    live.parent
      .querySelector('.ProseMirror')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    expect(hotkey).toHaveBeenCalledTimes(1);
  });

  it('Mod+G goes through the matches while the search is open', async () => {
    const ed = await open(NOTE);
    ed.search({ search: 'fox' });
    const key = (init: KeyboardEventInit) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true, ...init }),
      );
    key({ ctrlKey: true });
    key({ ctrlKey: true });
    expect(findStateOf(ed.view.state)?.current).toBe(1);
    key({ ctrlKey: true, shiftKey: true });
    expect(findStateOf(ed.view.state)?.current).toBe(0);
  });
});

describe('go to a line', () => {
  it('puts the caret at the start of the line of the source, in a block that is folded too', async () => {
    const ed = await open(NOTE);
    ed.editor.gotoLine(7);
    expect(ed.editor.cursor().line).toBe(7);
    ed.editor.gotoLine(9999);
    // the last line of the file is empty, and a caret cannot be there: the last line of text
    expect(ed.editor.cursor().line).toBe(NOTE.split('\n').length - 1);
    ed.editor.gotoLine(-3);
    expect(ed.editor.cursor().line).toBe(1);
  });
});

describe('folding', () => {
  const hidden = (ed: Ed) =>
    [...ed.parent.querySelectorAll('.live-fold-hidden')].map((e) => e.textContent);

  it('folds a heading over the blocks up to the next heading of its level, and opens again', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('Alpha');
    expect(foldCode(ed.view.state, ed.view.dispatch)).toBe(true);
    // Alpha holds a paragraph, Beta (a heading below it) and Beta's paragraph; Gamma is its sibling
    expect(hidden(ed)).toEqual(['one fox and another Fox here', 'Beta', 'the fox again']);
    expect(ed.parent.querySelector('.live-fold-chevron')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(ed.parent.querySelector('[data-folded="heading"]')?.textContent).toContain('Alpha');
    // the caret stays where the user is: on the heading
    expect(ed.editor.cursor().line).toBe(1);
    (ed.parent.querySelector('.live-fold-chevron') as HTMLElement).dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    expect(hidden(ed)).toEqual([]);
    expect(foldStateOf(ed.view.state)?.folded.size).toBe(0);
  });

  it('folds a heading inside another, which folds on its own', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('Beta');
    foldCode(ed.view.state, ed.view.dispatch);
    expect(hidden(ed)).toEqual(['the fox again']);
  });

  it('is no edit: the note is not dirty and its text is the file', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('Alpha');
    foldCode(ed.view.state, ed.view.dispatch);
    foldAll(ed.view.state, ed.view.dispatch);
    unfoldAll(ed.view.state, ed.view.dispatch);
    expect(ed.editor.edited).toBe(false);
    expect(ed.changes).not.toHaveBeenCalled();
    expect(ed.editor.text()).toBe(NOTE);
  });

  it('folds what CodeMirror folds in a Markdown note: the items of a list, quotes, code and tables', async () => {
    const note = [
      '- item one',
      '  - nested',
      '- item two',
      '',
      '> quote',
      '>',
      '> second paragraph',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '> [!note] A callout',
      '> its body',
      '',
    ].join('\n');
    const ed = await open(note);
    const kinds: string[] = [];
    ed.view.state.doc.descendants((node, pos) => {
      const f = foldableAt(ed.view.state.doc, pos);
      if (f) kinds.push(`${f.kind}`);
      return node.type.name !== 'table' && !node.isTextblock;
    });
    // the callout has a fold of its own, and "item two" has nothing to hide
    expect(kinds).toEqual(['item', 'quote', 'code', 'table']);
  });

  it('folds an item over its nested list, a code block to its header and a table to its header row', async () => {
    const note = [
      '- item one',
      '  - nested',
      '- item two',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
    ].join('\n');
    const ed = await open(note);
    ed.caretAfter('item one');
    foldCode(ed.view.state, ed.view.dispatch);
    expect(ed.parent.querySelector('.live-folded-item')).not.toBeNull();
    expect(hidden(ed).map((t) => t?.trim())).toEqual(['nested']);
    ed.caretAfter('const a');
    foldCode(ed.view.state, ed.view.dispatch);
    expect(ed.parent.querySelector('.live-folded-code')).not.toBeNull();
    ed.caretAfter('item two');
    ed.editor.gotoLine(9);
    // the table is cells: fold it by position, the way the chevron does
    let table = -1;
    ed.view.state.doc.descendants((n, pos) => {
      if (n.type.name === 'table') table = pos;
      return table < 0;
    });
    expect(toggleFoldAt(ed.view, table)).toBe(true);
    expect(ed.parent.querySelector('.live-folded-table')).not.toBeNull();
    expect(hidden(ed).length).toBeGreaterThan(1);
  });

  it('opens a fold the caret moves into: the caret is never in what is hidden', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('Alpha');
    foldCode(ed.view.state, ed.view.dispatch);
    expect(foldStateOf(ed.view.state)?.folded.size).toBe(1);
    ed.editor.gotoLine(3); // a line of the section
    expect(foldStateOf(ed.view.state)?.folded.size).toBe(0);
    expect(hidden(ed)).toEqual([]);
    // and a search that lands in it
    ed.caretAfter('Alpha');
    foldCode(ed.view.state, ed.view.dispatch);
    ed.search({ search: 'again' });
    findNext(ed.view, 1);
    expect(foldStateOf(ed.view.state)?.folded.size).toBe(0);
  });

  it('leaves a fold alone when the selection takes more than what it hides (select all)', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('Alpha');
    foldCode(ed.view.state, ed.view.dispatch);
    ed.view.dispatch(
      ed.view.state.tr.setSelection(
        TextSelection.create(ed.view.state.doc, 1, ed.view.state.doc.content.size - 1),
      ),
    );
    expect(foldStateOf(ed.view.state)?.folded.size).toBe(1);
  });

  it('keeps a fold on its block through the edits before it, and drops one that is no longer a block of its kind', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('Beta');
    foldCode(ed.view.state, ed.view.dispatch);
    const before = [...(foldStateOf(ed.view.state)?.folded.keys() ?? [])][0] as number;
    ed.view.dispatch(ed.view.state.tr.insertText('Zero ', 2));
    const after = [...(foldStateOf(ed.view.state)?.folded.keys() ?? [])][0] as number;
    expect(after).toBe(before + 'Zero '.length);
    // Beta becomes a paragraph: nothing to fold there any more
    const doc = ed.view.state.doc;
    let pos = -1;
    doc.descendants((n, p) => {
      if (n.type.name === 'heading' && n.textContent === 'Beta') pos = p;
      return pos < 0;
    });
    ed.view.dispatch(ed.view.state.tr.setNodeMarkup(pos, ed.view.state.schema.nodes['paragraph']));
    expect(foldStateOf(ed.view.state)?.folded.size).toBe(0);
  });

  it('folds and opens all with the keys of the Source editor', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('last paragraph');
    const key = (init: KeyboardEventInit) =>
      ed.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      );
    key({ key: ']', code: 'BracketRight', keyCode: 221, ctrlKey: true, altKey: true });
    key({ key: '[', code: 'BracketLeft', keyCode: 219, ctrlKey: true, altKey: true });
    // Gamma (it holds the caret) stays open; Alpha and Beta fold
    expect([...(foldStateOf(ed.view.state)?.folded.values() ?? [])]).toEqual([
      'heading',
      'heading',
    ]);
    key({ key: ']', code: 'BracketRight', keyCode: 221, ctrlKey: true, altKey: true });
    expect(foldStateOf(ed.view.state)?.folded.size).toBe(0);
  });

  it('is turned off with the setting, and the folds go with it', async () => {
    const ed = await open(NOTE);
    ed.caretAfter('Alpha');
    foldCode(ed.view.state, ed.view.dispatch);
    ed.editor.applySettings({ ...DEFAULT_LIVE_SETTINGS, foldHeadings: false });
    expect(foldStateOf(ed.view.state)?.enabled).toBe(false);
    expect(hidden(ed)).toEqual([]);
    expect(foldCode(ed.view.state, ed.view.dispatch)).toBe(false);
    ed.editor.applySettings({ ...DEFAULT_LIVE_SETTINGS, foldHeadings: true });
    expect(foldCode(ed.view.state, ed.view.dispatch)).toBe(true);
    expect(foldKey.getState(ed.view.state)?.folded.size).toBe(1);
  });
});

describe('settings that follow the application', () => {
  it('sets the type size, the tab width and wrapping on the editor, and the spellchecker', async () => {
    const ed = await open(NOTE);
    expect(ed.parent.style.getPropertyValue('--live-font-size')).toBe('15px');
    expect(ed.parent.dataset['wrap']).toBe('true');
    ed.editor.applySettings({
      ...DEFAULT_LIVE_SETTINGS,
      fontSize: 22,
      tabSize: 2,
      wrap: false,
      spellcheck: false,
    });
    expect(ed.parent.style.getPropertyValue('--live-font-size')).toBe('22px');
    expect(ed.parent.style.getPropertyValue('--live-tab-size')).toBe('2');
    expect(ed.parent.dataset['wrap']).toBe('false');
    expect(ed.view.dom.getAttribute('spellcheck')).toBe('false');
    ed.editor.applySettings({ ...DEFAULT_LIVE_SETTINGS, spellcheck: true });
    expect(ed.view.dom.getAttribute('spellcheck')).toBe('true');
  });

  it('starts with the settings it was given', async () => {
    const ed = await open(NOTE, { fontSize: 19, wrap: false, spellcheck: true });
    expect(ed.parent.style.getPropertyValue('--live-font-size')).toBe('19px');
    expect(ed.parent.dataset['wrap']).toBe('false');
    expect(ed.view.dom.getAttribute('spellcheck')).toBe('true');
  });

  it('takes a change of theme and of tab width for the code blocks without an error', async () => {
    const ed = await open('```js\nconst a = 1;\n```\n');
    expect(() => {
      ed.editor.applySettings({ ...DEFAULT_LIVE_SETTINGS, dark: true });
      ed.editor.applySettings({ ...DEFAULT_LIVE_SETTINGS, dark: true, tabSize: 8 });
      ed.editor.applySettings({ ...DEFAULT_LIVE_SETTINGS, dark: false, tabSize: 2 });
    }).not.toThrow();
    expect(ed.editor.text()).toBe('```js\nconst a = 1;\n```\n');
    expect(ed.editor.edited).toBe(false);
  });
});
