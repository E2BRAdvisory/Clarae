// A property of the Live editor (W9): whatever the user does to a task, the text the editor saves opens
// again in Live and says the same tasks. The box of a task is on the line of the marker, never on another
// one (`-`, a line break, `[x]` is no task and the note is refused), and the number and the state of the
// tasks that the file can say do not change by saving and opening. The items that Live shows nested are
// nested for the file too (an empty item is no end of the item that follows it: `-`, a blank line, `  - a`).
//
// The edits are the keys and the paste a user has at hand, tried at the start, the middle and the end of every
// text block of a set of notes (tasks with a paragraph of several lines, blocks that follow the head, nested
// tasks, tasks in a quote and in a callout, CRLF): Enter, Shift+Enter, a block pasted, and the syntax of a
// block typed (`# `, `- `, `> `, `[ ] `, `---`, a fence, `$$`), and the text of a block cleared.
import { TextSelection } from '@milkdown/kit/prose/state';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import {
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  splitBlock,
} from '@milkdown/kit/prose/commands';
import { extract } from '@memobrain/markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../../i18n';
import { EditorViewOf, openLive } from '../testing/mounted';
import { inertInput } from './index';

vi.setConfig({ testTimeout: 600_000 });
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

const NOTES: Record<string, string> = {
  'multi-line head': '- [x] a\n  b\n  c\n',
  'multi-line head, open, then a block': '- [ ] a\n  b\n\n  para two\n\n  - [x] nested\n',
  'nested tasks': '- [ ] a\n  - [x] b\n    - [ ] c\n- [ ] d\n',
  'ordered tasks': '1. [ ] a\n2. [x] b\n   c\n',
  'loose list': '- [ ] a\n\n- [x] b\n',
  'task with a fence': '- [x] a\n  ```\n  code\n  ```\n',
  'task in a quote': '> - [x] a\n>   b\n> - [ ] c\n',
  'task in a callout': '> [!note] Title\n> - [ ] a\n>   b\n> - [x] c\n',
  'CRLF, multi-line head': '- [x] a\r\n  b\r\n  c\r\n- [ ] d\r\n',
  'CRLF, in a callout': '> [!tip]\r\n> - [x] a\r\n>   b\r\n',
  'bullets next to tasks': '- plain\n  more\n- [ ] task\n  more\n',
  'wide nested list': '- x\n\n  - y\n\n    - [ ] a\n',
  'wide nested list in a quote': '> - x\n>\n>   - y\n>\n>     - [ ] a\n',
  'wide ordered list with a paragraph': '1. x\n\n   para\n\n   - y\n',
  'ordered tasks nested in a task': '- [x] b\n  1. [ ] nn\n  2. [x] mm\n',
  'ordered tasks nested in an ordered task': '1. [x] b\n   1. [ ] nn\n   2. [x] mm\n',
  'ordered tasks nested in a bullet': '- b\n  1. [ ] nn\n  2. [x] mm\n- c\n',
};

/** The edits of a user: keys and typed text that reach ProseMirror the way the browser hands them. */
type Edit = { name: string; opens?: true } & (
  | { key: 'Enter'; shift?: boolean }
  | { type: string }
  | { paste: string }
  | { clear: true }
  | { seq: Edit[] }
);

const EDITS: Edit[] = [
  { name: 'Enter', key: 'Enter' },
  { name: 'Shift+Enter', key: 'Enter', shift: true },
  { name: 'clear the text', clear: true },
  { name: 'paste list', paste: '- x\n- y' },
  { name: 'paste heading', paste: '# h' },
  { name: 'paste quote', paste: '> q' },
  { name: 'paste rule', paste: '---' },
  { name: 'paste fence', paste: '```\ncode\n```' },
  { name: 'paste task', paste: '- [ ] t\n- [x] u' },
  { name: 'paste lines', paste: 'p\nq' },
  { name: 'type heading', type: '# ' },
  { name: 'type bullet', type: '- ' },
  { name: 'type quote', type: '> ' },
  { name: 'type box', type: '[ ] ' },
  { name: 'type number', type: '1. ' },
  { name: 'type rule', type: '---' },
  { name: 'type fence', type: '```' },
  { name: 'type math', type: '$$' },
  { name: 'type callout', type: '> [!note] ' },
  { name: 'paste ordered list', paste: '1. a\n2. b' },
  // a line break typed first (the cursor goes after it), then something pasted: the text of a task that
  // starts with a line break is no text for the file, and what is pasted must not leave the box behind
  ...[
    ['list', '- x\n- y'],
    ['ordered list', '1. a\n2. b'],
    ['table', '| a | b |\n| - | - |\n| 1 | 2 |'],
    ['code', '```\ncode\n```'],
    ['quote', '> q'],
    ['heading', '# h'],
    ['rule', '---'],
    ['math', '$$'],
    ['comment', '%%'],
    ['paragraphs', 'x\n\ny'],
  ].map(([what, text]): Edit => ({
    name: `Shift+Enter, then paste ${what}`,
    // `%%` and `$$` open a comment and a formula over what follows them, as in Source: what is read after
    // them is no task, and the property that holds is that the note opens again as it was written
    ...(what === 'comment' || what === 'math' ? { opens: true as const } : {}),
    seq: [
      { name: 'Shift+Enter', key: 'Enter', shift: true },
      { name: 'paste', paste: text! },
    ],
  })),
];

const enter = chainCommands(newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock);

function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

function pasteText(view: EditorView, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { files: [], getData: (t: string) => (t === 'text/plain' ? text : '') },
  });
  view.dom.dispatchEvent(ev);
}

/** The offsets worth trying in a text block: every place of a short one (around its line breaks), the ends of a long one. */
function offsets(doc: PMNode): number[] {
  const at: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const size = node.content.size;
    const some = new Set([0, size]);
    if (size <= 10) for (let o = 1; o < size; o++) some.add(o);
    else some.add(1);
    for (const o of some) at.push(pos + 1 + o);
    return false;
  });
  return at;
}

/**
 * The states of the tasks of a document, in order, as the file can say them: a task whose first paragraph is
 * empty has no text after its box, and `- [ ]` alone is no task (the file has no way to say it).
 */
function tasksOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'list_item' || node.attrs['checked'] == null) return true;
    const head = node.firstChild;
    const hollow = head?.type.name === 'paragraph' && head.content.size === 0;
    if (!hollow) out.push(node.attrs['checked'] ? 'x' : ' ');
    return true;
  });
  return out;
}

/** The depths of the list items of a document (the items that hold the item), in order. */
function depthsOf(doc: PMNode): string {
  const out: number[] = [];
  const walk = (node: PMNode, depth: number): void => {
    node.forEach((k) => {
      if (k.type.name === 'list_item') out.push(depth);
      walk(k, depth + (k.type.name === 'list_item' ? 1 : 0));
    });
  };
  walk(doc, 0);
  return out.join('');
}

interface MdNode {
  type: string;
  children?: MdNode[];
}

/** The same, for the text, as a Markdown parser reads it. */
function depthsIn(text: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text) as MdNode;
  const out: number[] = [];
  const walk = (node: MdNode, depth: number): void => {
    for (const k of node.children ?? []) {
      if (k.type === 'listItem') out.push(depth);
      walk(k, depth + (k.type === 'listItem' ? 1 : 0));
    }
  };
  walk(tree, 0);
  return out.join('');
}

/** The states of the tasks a text says, as the index reads them (a line with a box after a marker). */
const tasksIn = (text: string): string[] => extract('t.md', text).tasks.map((t) => t.state);

/** One edit, at the selection the view has (`at`: the text block the edit is for, for the one that clears it). */
async function perform(view: EditorView, edit: Edit, at: number): Promise<void> {
  if ('seq' in edit) {
    for (const step of edit.seq) await perform(view, step, at);
  } else if ('key' in edit) {
    const ev = new KeyboardEvent('keydown', {
      key: edit.key,
      shiftKey: edit.shift ?? false,
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(ev);
    if (!ev.defaultPrevented && !edit.shift) enter(view.state, view.dispatch.bind(view));
  } else if ('type' in edit) {
    typeText(view, edit.type);
  } else if ('clear' in edit) {
    const $at = view.state.doc.resolve(at);
    view.dispatch(view.state.tr.delete($at.start(), $at.end()));
  } else {
    pasteText(view, edit.paste);
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function run(note: string, at: number, edit: Edit): Promise<string | null> {
  const live = await openLive(note, { input: { ...inertInput, delayMs: 0 } });
  opened.push(live);
  const view = EditorViewOf(live.editor);
  try {
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).scrollIntoView(),
    );
    await perform(view, edit, at);
  } catch {
    // an edit the editor's commands do not take (a selection no command applies to) writes nothing
    return null;
  }
  const text = live.editor.text();
  const expected = tasksOf(view.state.doc);
  let again: Awaited<ReturnType<typeof openLive>>;
  try {
    again = await openLive(text, { input: { ...inertInput, delayMs: 0 } });
  } catch (e) {
    return `refused (${(e as Error).message}) for ${JSON.stringify(text)}`;
  }
  opened.push(again);
  // the text says the tasks the document had (a box on another line than its marker says none), and what
  // the editor shows of the reopened note, as much as it can hold of it, says the same text again
  const got = tasksIn(text);
  // (a comment or a formula opened over the rest: the tasks and the items after it are its text)
  if (!edit.opens && got.join('') !== expected.join('')) {
    return `tasks [${expected.join('')}] became [${got.join('')}] for ${JSON.stringify(text)}`;
  }
  if (!edit.opens && depthsIn(text) !== depthsOf(view.state.doc)) {
    return `items at depths ${depthsOf(view.state.doc)} became ${depthsIn(text)} for ${JSON.stringify(text)}`;
  }
  if (again.editor.text() !== text) {
    return `the note is not the same after it is opened and written: ${JSON.stringify(text)}`;
  }
  return null;
}

describe('a task is saved on one line with its marker, and the note opens again with the same tasks', () => {
  for (const [name, note] of Object.entries(NOTES)) {
    it(name, async () => {
      const probe = await openLive(note, { input: { ...inertInput, delayMs: 0 } });
      opened.push(probe);
      const sites = offsets(EditorViewOf(probe.editor).state.doc);
      expect(sites.length).toBeGreaterThan(0);
      const bad: string[] = [];
      for (const at of sites) {
        for (const edit of EDITS) {
          const why = await run(note, at, edit);
          if (why) bad.push(`${edit.name} at ${at}: ${why}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('keeps the text of a task on the line of its box when a line break is typed at its start and blocks are pasted', async () => {
    for (const [pasted, text] of [
      ['- x\n- y', '- [ ] first line\n  - x\n  - y\n'],
      ['x\n\ny', '- [ ] x\n\n  y\n\n  first line\n'],
      ['```\ncode\n```', '- [ ] first line\n  ```\n  code\n  ```\n'],
    ] as const) {
      const live = await openLive('- [ ] first line\n', { input: { ...inertInput, delayMs: 0 } });
      opened.push(live);
      const view = EditorViewOf(live.editor);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
      await perform(
        view,
        {
          name: 'seq',
          seq: [
            { name: 'Shift+Enter', key: 'Enter', shift: true },
            { name: 'paste', paste: pasted },
          ],
        },
        3,
      );
      expect(live.editor.text(), pasted).toBe(text);
      const again = await openLive(live.editor.text(), { input: { ...inertInput, delayMs: 0 } });
      opened.push(again);
      expect(again.editor.text()).toBe(text);
    }
  });

  it('keeps the box of a task next to its marker when Enter splits a head of several lines', async () => {
    const live = await openLive('- [x] a\n  b\n  c\n', { input: { ...inertInput, delayMs: 0 } });
    opened.push(live);
    const view = EditorViewOf(live.editor);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    view.dom.dispatchEvent(ev);
    if (!ev.defaultPrevented) enter(view.state, view.dispatch.bind(view));
    const text = live.editor.text();
    expect(text).not.toMatch(/^-\s*$/m);
    expect(text).not.toMatch(/^\[x\]/m);
  });
});
