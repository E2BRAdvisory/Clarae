// The blocks of a narrow item (no blank line between its blocks) are written so that the file says the blocks
// the editor shows (consolidation, the three serious cases of the W10 review): a paragraph after a list, a quote or
// a table is no line of it, and a rule after a line of text is no heading underline. Each case is the user's own
// sequence on a mounted editor; the text saved, the index's reading of it and the note opened again are checked.
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { extract } from '@clarae/markdown';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../../i18n';
import { renderMarkdown } from '../../../reading/render';
import { EditorViewOf, openLive } from '../testing/mounted';
import { inertInput } from './index';

beforeAll(() => {
  initI18n('en');
  // the upload plugin of Milkdown asks `event instanceof ClipboardEvent`, which jsdom has no class for
  vi.stubGlobal('ClipboardEvent', class ClipboardEvent extends Event {});
  vi.stubGlobal('DragEvent', class DragEvent extends Event {});
});

const opened: { dispose(): void }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.dispose();
  document.body.replaceChildren();
});

const options = { input: { ...inertInput, delayMs: 0 } };

async function mount(note: string): Promise<{ view: EditorView; text: () => string }> {
  const live = await openLive(note, options);
  opened.push(live);
  return { view: EditorViewOf(live.editor), text: () => live.editor.text() };
}

/** The caret right after the `n`th occurrence (from 0) of `word` in the text of the document. */
function caretAfter(view: EditorView, word: string, n = 0): void {
  let at = -1;
  let seen = 0;
  view.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return at < 0;
    let i = (node.text ?? '').indexOf(word);
    while (i >= 0) {
      if (seen++ === n) {
        at = pos + i + word.length;
        return false;
      }
      i = (node.text ?? '').indexOf(word, i + 1);
    }
    return true;
  });
  if (at < 0) throw new Error(`no ${word}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

function select(view: EditorView, word: string): void {
  caretAfter(view, word);
  const to = view.state.selection.from;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, to - word.length, to)),
  );
}

function key(view: EditorView, name: string, shift = false): void {
  const ev = new KeyboardEvent('keydown', {
    key: name,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  view.dom.dispatchEvent(ev);
  if (ev.defaultPrevented) return;
  if (name === 'Backspace') {
    const { from, to } = view.state.selection;
    view.dispatch(view.state.tr.delete(from, to));
  }
}

async function paste(view: EditorView, text: string): Promise<void> {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { files: [], getData: (t: string) => (t === 'text/plain' ? text : '') },
  });
  view.dom.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
}

const ws = (html: string): string => html.replace(/\s+/g, ' ').trim();

/** The text opens again in Live as it was written, with `raws` blocks the editor cannot edit (none by default). */
async function opensAgain(text: string, raws = 0): Promise<void> {
  const again = await mount(text);
  expect(again.text(), text).toBe(text);
  let raw = 0;
  again.view.state.doc.descendants((n) => {
    if (n.type.name === 'raw_block') raw++;
    return true;
  });
  expect(raw, text).toBe(raws);
}

describe('a wide item whose text is cleared keeps the paragraph after its table or quote out of it', () => {
  for (const [note, saved, inside] of [
    ['- q\n\n  | a |\n  | - |\n\n  para\n', '-\n  | a |\n  | - |\n\n  para\n', '<td>para'],
    ['- q\n\n  > a\n\n  para\n', '-\n  > a\n\n  para\n', 'a para'],
  ] as const) {
    it(JSON.stringify(note), async () => {
      const { view, text } = await mount(note);
      select(view, 'q');
      key(view, 'Backspace');
      expect(text()).toBe(saved);
      expect(ws(renderMarkdown(text()))).not.toContain(inside);
      expect(ws(renderMarkdown(text()))).toContain('<p>para</p>');
      // an item that does not start with a paragraph is one Live cannot edit (ADR-0049, §9): its list is a raw block
      await opensAgain(text(), 1);
    });
  }
});

describe('a list or a table pasted in the middle of the text of a narrow item leaves the rest of the text after it', () => {
  for (const [note, pasted, saved] of [
    ['- [ ] first line\n', '- x\n- y', '- [ ] first\n  - x\n  - y\n\n  line\n'],
    ['- first line\n', '- x\n- y', '- first\n  - x\n  - y\n\n  line\n'],
    ['1. first line\n', '- x\n- y', '1. first\n   - x\n   - y\n\n   line\n'],
    [
      '- [ ] first line\n',
      '| a | b |\n| - | - |\n| 1 | 2 |',
      '- [ ] first\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n\n  line\n',
    ],
    ['> - first line\n', '- x\n- y', '> - first\n>   - x\n>   - y\n>\n>   line\n'],
  ] as const) {
    it(`${JSON.stringify(pasted)} into ${JSON.stringify(note)}`, async () => {
      const { view, text } = await mount(note);
      caretAfter(view, 'first');
      await paste(view, pasted);
      expect(text()).toBe(saved);
      // the text after the paste is a paragraph of the item, not a line of the last pasted item or a row
      const html = ws(renderMarkdown(text()));
      expect(html).toMatch(/<\/(ul|table)> (<p>)?line/);
      expect(html).not.toMatch(/y line|<td>line/);
      expect(extract('t.md', text()).tasks).toHaveLength(note.includes('[ ]') ? 1 : 0);
      await opensAgain(text());
    });
  }

  it('takes the blanks away from the start of the text after the pasted blocks, in the editor too', async () => {
    const { view } = await mount('- first \t line\n');
    caretAfter(view, 'first');
    await paste(view, '- x\n- y');
    const texts: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.type.name === 'paragraph') texts.push(n.textContent);
      return true;
    });
    expect(texts).toEqual(['first', 'x', 'y', 'line']);
  });

  it('keeps the blanks of a paste in the middle of a line that is no block (the text goes in as text)', async () => {
    const { view, text } = await mount('first line\n');
    caretAfter(view, 'first');
    await paste(view, 'and');
    expect(text()).toBe('firstand line\n');
  });
});

describe('a rule after the text of a narrow item is no underline of it', () => {
  for (const [note, word, saved] of [
    ['- [ ] first line\n- [ ] second\n', 'line', '- [ ] first line\n  ***\n- [ ] second\n'],
    ['- first line\n- second\n', 'line', '- first line\n  ***\n- second\n'],
    ['1. first line\n2. second\n', 'line', '1. first line\n   ***\n2. second\n'],
    ['1) [x] first line\n2) [ ] second\n', 'line', '1) [x] first line\n   ***\n2) [ ] second\n'],
    ['- a\n  - [ ] first line\n', 'line', '- a\n  - [ ] first line\n    ***\n'],
    [
      '> - [ ] first line\n> - [ ] second\n',
      'line',
      '> - [ ] first line\n>   ***\n> - [ ] second\n',
    ],
    [
      '- [ ] first line\r\n- [ ] second\r\n',
      'line',
      '- [ ] first line\r\n  ***\r\n- [ ] second\r\n',
    ],
  ] as const) {
    it(JSON.stringify(note), async () => {
      const { view, text } = await mount(note);
      caretAfter(view, word);
      key(view, 'Enter', true);
      key(view, 'Enter', true);
      await paste(view, '---');
      expect(text()).toBe(saved);
      expect(extract('t.md', text()).headings).toEqual([]);
      expect(extract('t.md', text()).tasks).toHaveLength((note.match(/\[[ x]\]/g) ?? []).length);
      expect(ws(renderMarkdown(text()))).toContain('<hr');
      await opensAgain(text());
    });
  }
});
