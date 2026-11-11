import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Selection } from '@milkdown/kit/prose/state';
import { describe, expect, it, vi } from 'vitest';
import { describeHandleContract, type HandleFactory } from '../handleContract';
import { locInText, locOf, posAt } from './positions';
import { EditorViewOf, openLive, options } from './testing/mounted';
import { LiveSession } from './fidelity/session';
import { LiveEditor, openLiveEditor, type Refused } from './MilkdownAdapter';
import { posAfter } from './testing/helpers';

const milkdown: HandleFactory = async ({ doc, selection, readOnly }) => {
  const live = await openLive(doc, { readOnly: !!readOnly });
  if (selection) {
    live.editor.restore({
      anchor: locInText(doc, selection.anchor),
      head: locInText(doc, selection.head ?? selection.anchor),
      topLine: 1,
    });
  }
  return { handle: live.editor, dispose: () => live.dispose() };
};

describe('the Live adapter', () => {
  it('opens a note and gives its text back untouched', async () => {
    const raw = '---\ntitle: x\n---\n# Title\n\nSome *text*, a [[link]] and #tag.\n\n- [ ] task\n';
    const live = await openLive(raw);
    try {
      expect(live.editor.text()).toBe(raw);
      expect(live.editor.kind).toBe('live');
    } finally {
      live.dispose();
    }
  });
});

vi.setConfig({ testTimeout: 30_000 });
describeHandleContract('Milkdown', milkdown, { lineOriented: false });

// ---- what the real, mounted editor does with a note (the layer's tests run on a detached one) --------

const FIXTURE = [
  '---',
  'title: Demo',
  'tags: [a, b]',
  '---',
  '# Title',
  '',
  'Some *text* with a [[Link|alias]], a #tag, ==marked== and a ^block-id',
  '',
  '> [!note] Heads up',
  '> body of the callout',
  '',
  '- item one',
  '  - nested',
  '- [ ] a task',
  '- [x] done',
  '',
  '1. first',
  '2. second',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '<div>raw html</div>',
  '',
  '%% a comment %%',
  '',
  'last paragraph',
  '',
].join('\n');

describe('the mounted Live editor and the file', () => {
  it('writes nothing without input: loading, selecting, hovering and clicking leave every block clean', async () => {
    const changes = vi.fn();
    const restore = seeEverything(); // the code blocks draw their editors too
    const live = await openLive(FIXTURE, { onChange: changes });
    try {
      const view = EditorViewOf(live.editor);
      // every place of the document selected in turn
      for (let pos = 1; pos < view.state.doc.content.size; pos += 3) {
        try {
          view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))));
        } catch {
          /* a place that is not a cursor position */
        }
      }
      // hover and clicks on what is drawn
      for (const el of view.dom.querySelectorAll('*')) {
        for (const type of ['mouseover', 'mousemove', 'mouseenter', 'focusin']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        }
      }
      for (const el of view.dom.querySelectorAll(
        'blockquote, blockquote *, summary, [data-type]',
      )) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      expect(changes).not.toHaveBeenCalled();
      expect(live.editor.text()).toBe(FIXTURE);
      expect(live.editor.edited).toBe(false);
    } finally {
      live.dispose();
      restore();
    }
  });
});

// ---- typing --------------------------------------------------------------------------------------

/** Types `insert` right after the first `after` of the document, as the user would. */
function type(live: { editor: LiveEditor }, after: string, insert: string): void {
  const view = EditorViewOf(live.editor);
  const at = posAfter(view.state.doc, after);
  if (at < 0) throw new Error(`no text ${JSON.stringify(after)}`);
  view.dispatch(view.state.tr.insertText(insert, at));
}

describe('what the user types', () => {
  it('is reported with a getter of the text, which is not asked for until it is needed', async () => {
    const changes = vi.fn<(text: () => string) => void>();
    const live = await openLive('one\n\ntwo\n\nthree\n', { onChange: changes });
    try {
      const text = vi.spyOn(LiveEditor.prototype as unknown as { textOf(): string }, 'textOf');
      let typed = 'two';
      for (const ch of 'abc') {
        type(live, typed, ch);
        typed += ch;
      }
      expect(changes).toHaveBeenCalledTimes(3);
      expect(text).not.toHaveBeenCalled();
      const last = changes.mock.calls[2]![0];
      expect(last()).toBe('one\n\ntwoabc\n\nthree\n');
      last();
      expect(text).toHaveBeenCalledTimes(2); // (the getter, then the one the call above made: memoized)
      text.mockRestore();
    } finally {
      live.dispose();
    }
  });

  it('gives each getter the text of its own edit, whatever came after, and writes only the block it touched', async () => {
    const changes = vi.fn<(text: () => string) => void>();
    const live = await openLive('one\n\ntwo\n\nthree\n', { onChange: changes });
    try {
      type(live, 'one', '1');
      type(live, 'three', '3');
      const [first, second] = changes.mock.calls.map((c) => c[0]);
      expect(second!()).toBe('one1\n\ntwo\n\nthree3\n');
      expect(first!()).toBe('one1\n\ntwo\n\nthree\n');
      expect(live.editor.text()).toBe('one1\n\ntwo\n\nthree3\n');
    } finally {
      live.dispose();
    }
  });

  it('is written with the line ends the file has, and the frontmatter and the BOM stay as they are', async () => {
    const raw = '﻿---\r\ntitle: x\r\n---\r\n# Head\r\n\r\ntext\r\n\r\n- a\r\n- b\r\n';
    const live = await openLive(raw);
    try {
      type(live, 'text', '!');
      expect(live.editor.text()).toBe(raw.replace('text', 'text!'));
    } finally {
      live.dispose();
    }
  });

  it('can still be asked for after the editor is gone (a save that was waiting for the pause)', async () => {
    const changes = vi.fn<(text: () => string) => void>();
    const live = await openLive('one\n\ntwo\n', { onChange: changes });
    type(live, 'two', '!');
    const getter = changes.mock.calls[0]![0];
    live.dispose();
    expect(getter()).toBe('one\n\ntwo!\n');
    live.parent.remove();
  });

  it('is not reported when only a machine changed the document (the ids of the headings)', async () => {
    const changes = vi.fn();
    const live = await openLive('# One\n\ntext\n\n## Two\n', { onChange: changes });
    try {
      expect(changes).not.toHaveBeenCalled();
      expect(live.editor.edited).toBe(false);
      type(live, 'text', '.');
      expect(changes).toHaveBeenCalledTimes(1);
      expect(live.editor.edited).toBe(true);
    } finally {
      live.dispose();
    }
  });
});

// ---- the file changed outside --------------------------------------------------------------------

describe('a reload of the file', () => {
  it('shows the new text, is no edit, and cannot be undone', async () => {
    const changes = vi.fn();
    const live = await openLive('one\n\ntwo\n\nthree\n', { onChange: changes });
    try {
      expect(live.editor.reload('one\n\ntwo changed\n\n* three\n')).toBeNull();
      expect(live.editor.text()).toBe('one\n\ntwo changed\n\n* three\n');
      expect(changes).not.toHaveBeenCalled();
      expect(live.editor.edited).toBe(false);
      live.editor.exec('undo');
      expect(live.editor.text()).toBe('one\n\ntwo changed\n\n* three\n');
    } finally {
      live.dispose();
    }
  });

  it('keeps the earlier edits of the user in the history: undo takes back only what the user did', async () => {
    const live = await openLive('one\n\ntwo\n\nthree\n');
    try {
      type(live, 'one', 'X');
      // the note was saved as it is, and then another program changed a block further down
      expect(live.editor.reload('oneX\n\ntwo\n\nthree changed\n')).toBeNull();
      expect(live.editor.text()).toBe('oneX\n\ntwo\n\nthree changed\n');
      live.editor.exec('undo');
      expect(live.editor.text()).toBe('one\n\ntwo\n\nthree changed\n');
    } finally {
      live.dispose();
    }
  });

  it('is a change of form as well: a marker or a line end that only the file changed is not written back', async () => {
    const live = await openLive('- a\n- b\n\ntext\n');
    try {
      expect(live.editor.reload('* a\n* b\n\ntext\n')).toBeNull();
      expect(live.editor.text()).toBe('* a\n* b\n\ntext\n');
      type(live, 'text', '!');
      expect(live.editor.text()).toBe('* a\n* b\n\ntext!\n');
      expect(live.editor.reload('* a\r\n* b\r\n\r\ntext!\r\n')).toBeNull();
      expect(live.editor.text()).toBe('* a\r\n* b\r\n\r\ntext!\r\n');
    } finally {
      live.dispose();
    }
  });

  it('takes a change of the frontmatter alone without touching the document', async () => {
    const live = await openLive('---\na: 1\n---\n# T\n\ntext\n');
    try {
      const view = EditorViewOf(live.editor);
      const doc = view.state.doc;
      expect(live.editor.reload('---\na: 2\nb: 3\n---\n# T\n\ntext\n')).toBeNull();
      expect(view.state.doc).toBe(doc);
      expect(live.editor.text()).toBe('---\na: 2\nb: 3\n---\n# T\n\ntext\n');
    } finally {
      live.dispose();
    }
  });

  it('keeps the selection where it was', async () => {
    const live = await openLive('one\n\ntwo\n\nthree\n');
    try {
      live.editor.gotoLine(5);
      expect(live.editor.reload('one\n\ntwo\n\nthree and more\n')).toBeNull();
      expect(live.editor.cursor().line).toBe(5);
    } finally {
      live.dispose();
    }
  });

  it('refuses a text the editor cannot hold (and leaves what it shows as it was)', async () => {
    const live = await openLive('one\n\ntwo\n');
    try {
      const refused = live.editor.reload('one\r\ntwo\nthree\r\n') as Refused;
      expect(refused.reason).toBe('mixed-eol');
      expect(live.editor.text()).toBe('one\n\ntwo\n');
    } finally {
      live.dispose();
    }
  });

  it('no longer counts what was typed as an edit once a reload is refused', async () => {
    const live = await openLive('one\n\ntwo\n');
    try {
      live.editor.replaceSelection('X');
      expect(live.editor.edited).toBe(true);
      expect(live.editor.reload('one\r\ntwo\nthree\r\n')).not.toBeNull();
      expect(live.editor.edited).toBe(false);
    } finally {
      live.dispose();
    }
  });
});

// ---- read only -----------------------------------------------------------------------------------

describe('a read-only editor', () => {
  it('refuses edits and commands, stays focusable and keeps its caret, and still takes a reload', async () => {
    const changes = vi.fn();
    const live = await openLive('one\n\ntwo\n', { readOnly: true, onChange: changes });
    try {
      const view = EditorViewOf(live.editor);
      expect(live.editor.readOnly()).toBe(true);
      // the controls the editor draws are hidden by this (theme.css)
      expect(live.parent.dataset['readonly']).toBe('true');
      expect(view.editable).toBe(true);
      expect(view.dom.getAttribute('contenteditable')).toBe('true');
      type(live, 'one', 'X');
      expect(live.editor.text()).toBe('one\n\ntwo\n');
      expect(live.editor.exec('bold')).toBe(false);
      expect(live.editor.replaceSelection('x')).toBe(false);
      expect(live.editor.appendToLine(1, ' ^id')).toBe(false);
      expect(changes).not.toHaveBeenCalled();
      live.editor.gotoLine(3);
      expect(live.editor.cursor().line).toBe(3);
      live.editor.focus();
      expect(document.activeElement).toBe(live.editor.focusElement);
      expect(live.editor.reload('one\n\ntwo\n\nthree\n')).toBeNull();
      expect(live.editor.text()).toBe('one\n\ntwo\n\nthree\n');
      live.editor.setReadOnly(false);
      expect(live.parent.dataset['readonly']).toBe('false');
      type(live, 'three', '!');
      expect(live.editor.text()).toBe('one\n\ntwo\n\nthree!\n');
    } finally {
      live.dispose();
    }
  });

  it('never lets the browser follow a link of the document', async () => {
    const live = await openLive('[site](https://example.com) and [[Note]]\n', { readOnly: true });
    try {
      const a = live.parent.querySelector('a[href]');
      expect(a).not.toBeNull();
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      a!.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    } finally {
      live.dispose();
    }
  });
});

// ---- keys ----------------------------------------------------------------------------------------

/** A code block draws its editor when it is seen: here it is seen as soon as it is drawn. */
function seeEverything(): () => void {
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe(target: Element): void {
      this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as never;
  return () => {
    globalThis.IntersectionObserver = original;
  };
}

describe('the hotkeys of the application', () => {
  const key = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });

  it('arrive from the text, from a code block, from a table cell and from anything the editor draws', async () => {
    const seen: EventTarget[] = [];
    const restore = seeEverything();
    const live = await openLive('text\n\n```ts\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', {
      hotkey: () => (e) => {
        seen.push(e.target as EventTarget);
        return true;
      },
    });
    try {
      const view = EditorViewOf(live.editor);
      const targets = [
        view.dom,
        view.dom.querySelector('.cm-content'),
        view.dom.querySelector('td, th'),
        live.parent.querySelector('.milkdown'),
      ];
      for (const t of targets) {
        expect(t, 'the element exists').not.toBeNull();
        const e = key();
        t!.dispatchEvent(e);
        expect(e.defaultPrevented || seen.at(-1) === t).toBe(true);
      }
      expect(seen).toEqual(targets);
    } finally {
      live.dispose();
      restore();
    }
  });

  it('are handled once: the editor that holds the key does not get it when a command ran', async () => {
    const inner = vi.fn();
    const restore = seeEverything();
    const live = await openLive('text\n\n```ts\ncode\n```\n', { hotkey: () => () => true });
    try {
      const cm = EditorViewOf(live.editor).dom.querySelector('.cm-content') as HTMLElement;
      cm.addEventListener('keydown', inner);
      cm.dispatchEvent(key());
      expect(inner).not.toHaveBeenCalled();
    } finally {
      live.dispose();
      restore();
    }
  });

  it('are left to the editor when no command has them, and while a composition is going on', async () => {
    const hotkey = vi.fn(() => false);
    const live = await openLive('text\n', { hotkey: () => hotkey });
    try {
      const inner = vi.fn();
      live.editor.focusElement.addEventListener('keydown', inner);
      live.editor.focusElement.dispatchEvent(key());
      expect(hotkey).toHaveBeenCalledTimes(1);
      expect(inner).toHaveBeenCalledTimes(1);
      live.editor.focusElement.dispatchEvent(key({ isComposing: true }));
      live.editor.focusElement.dispatchEvent(key({ keyCode: 229 }));
      expect(hotkey).toHaveBeenCalledTimes(1);
    } finally {
      live.dispose();
    }
  });
});

describe('the accessible name', () => {
  it('is on the element that takes the typing, which is a multi-line text box', async () => {
    const live = await openLive('text\n', { ariaLabel: 'Note editor' });
    try {
      expect(live.editor.focusElement.getAttribute('aria-label')).toBe('Note editor');
      expect(live.editor.focusElement.getAttribute('role')).toBe('textbox');
      expect(live.editor.focusElement.getAttribute('aria-multiline')).toBe('true');
    } finally {
      live.dispose();
    }
  });
});

describe('a note the editor cannot hold', () => {
  it('opens as a refusal when the layer does not give the note back as it is', async () => {
    const text = vi.spyOn(LiveSession.prototype, 'text').mockReturnValue('something else');
    try {
      const parent = document.body.appendChild(document.createElement('div'));
      expect(await openLiveEditor(parent, 'text\n', options())).toMatchObject({
        ok: false,
        reason: 'identity',
      });
      expect(parent.querySelector('.milkdown')).toBeNull();
      parent.remove();
    } finally {
      text.mockRestore();
    }
  });

  it('opens as a refusal, with the reason, and leaves nothing behind', async () => {
    const parent = document.body.appendChild(document.createElement('div'));
    const r = await openLiveEditor(parent, 'a\r\nb\nc\r\n', options());
    expect(r).toMatchObject({ ok: false, reason: 'mixed-eol' });
    expect(parent.querySelector('.milkdown')).toBeNull();
    parent.remove();
  });

  it('opens as a refusal when the layer cannot read the note without losing content', async () => {
    const open = vi
      .spyOn(LiveSession, 'open')
      .mockReturnValue({ ok: false, reason: 'parse-error', detail: 'lost a node' });
    try {
      const parent = document.body.appendChild(document.createElement('div'));
      expect(await openLiveEditor(parent, 'text\n', options())).toMatchObject({
        ok: false,
        reason: 'parse-error',
      });
      parent.remove();
    } finally {
      open.mockRestore();
    }
  });
});

// ---- places of the text ----------------------------------------------------------------------------

describe('lines and columns', () => {
  it('give back the place they were taken from, inside marks, links and list items', async () => {
    const live = await openLive(FIXTURE);
    try {
      const view = EditorViewOf(live.editor);
      const textSource = (live.editor as unknown as { textSource: Parameters<typeof locOf>[0] })
        .textSource;
      const doc = view.state.doc;
      let checked = 0;
      doc.descendants((node, pos) => {
        if (!node.inlineContent) return true;
        for (let p = pos + 1; p <= pos + 1 + node.content.size; p += 2) {
          const loc = locOf(textSource, doc, p);
          const back = posAt(textSource, doc, loc);
          expect(locOf(textSource, doc, back), `place ${p}`).toEqual(loc);
          checked++;
        }
        return false;
      });
      expect(checked).toBeGreaterThan(40);
    } finally {
      live.dispose();
    }
  });
});

// ---- the commands, on blocks -------------------------------------------------------------------------

describe('the formatting commands of a document of blocks', () => {
  interface Case {
    command: Parameters<LiveEditor['exec']>[0];
    doc: string;
    /** [from, to] of the selection, as source offsets. */
    select: [number, number?];
    result: string;
    /** The command again on its own result gives the document back. */
    toggles?: boolean;
  }
  const inline = (command: Case['command'], open: string, close = open): Case => ({
    command,
    doc: 'say hello now',
    select: [4, 9],
    result: `say ${open}hello${close} now`,
    toggles: true,
  });
  const two = 'one\n\ntwo\n';
  const CASES: Case[] = [
    inline('bold', '**'),
    inline('italic', '*'),
    inline('strike', '~~'),
    inline('code', '`'),
    inline('highlight', '=='),
    inline('underline', '<u>', '</u>'),
    inline('sub', '<sub>', '</sub>'),
    inline('sup', '<sup>', '</sup>'),
    {
      command: 'comment',
      doc: 'say hello now',
      select: [4, 9],
      result: 'say %%hello%% now',
      toggles: true,
    },
    { command: 'heading-2', doc: 'plain\n\nnext\n', select: [2], result: '## plain\n\nnext\n' },
    { command: 'heading-1', doc: '#### deep\n', select: [6], result: '# deep\n' },
    { command: 'bullet', doc: two, select: [0, 8], result: '- one\n- two\n', toggles: true },
    { command: 'numbered', doc: two, select: [0, 8], result: '1. one\n2. two\n', toggles: true },
    { command: 'quote', doc: two, select: [0, 8], result: '> one\n>\n> two\n', toggles: true },
    { command: 'task', doc: two, select: [0, 8], result: '- [ ] one\n- [ ] two\n' },
    { command: 'wikilink', doc: 'x y', select: [1], result: 'x[[]] y' },
    { command: 'embed', doc: 'x y', select: [1], result: 'x![[]] y' },
    { command: 'wikilink', doc: 'say hello now', select: [4, 9], result: 'say [[hello]] now' },
    { command: 'callout', doc: 'text\n', select: [4], result: 'text\n\n> [!note] \n' },
    { command: 'code-block', doc: 'text\n', select: [4], result: 'text\n\n```\n```\n' },
    { command: 'separator', doc: 'para\n', select: [2], result: 'para\n\n---\n' },
    { command: 'link', doc: 'say hello now', select: [4, 9], result: 'say [hello](url) now' },
  ];

  it.each(CASES)(
    '$command on "$doc" writes what the file reads back as the same thing',
    async (c) => {
      const live = await openLive(c.doc);
      try {
        live.editor.restore({
          anchor: locInText(c.doc, c.select[0]),
          head: locInText(c.doc, c.select[1] ?? c.select[0]),
          topLine: 1,
        });
        expect(live.editor.exec(c.command)).toBe(true);
        expect(live.editor.text()).toBe(c.result);
        expect(live.editor.exec('undo')).toBe(true);
        expect(live.editor.text()).toBe(c.doc);
        live.editor.exec('redo');
        if (c.toggles) {
          live.editor.exec(c.command);
          expect(live.editor.text()).toBe(c.doc);
        }
      } finally {
        live.dispose();
      }
    },
  );

  it('leaves the caret after the blank of a callout head, where the title is typed', async () => {
    const live = await openLive('text\n');
    try {
      live.editor.restore({
        anchor: locInText('text\n', 4),
        head: locInText('text\n', 4),
        topLine: 1,
      });
      expect(live.editor.exec('callout')).toBe(true);
      const view = EditorViewOf(live.editor);
      const { from } = view.state.selection;
      view.dispatch(view.state.tr.insertText('Title', from));
      expect(live.editor.text()).toBe('text\n\n> [!note] Title\n');
    } finally {
      live.dispose();
    }
  });

  it('cycles the tasks of a list as editor:task does in Source: open, done, plain', async () => {
    const live = await openLive('- [ ] one\n- [x] two\n');
    try {
      live.editor.restore({ anchor: { line: 1, col: 1 }, head: { line: 2, col: 9 }, topLine: 1 });
      expect(live.editor.exec('task')).toBe(true);
      expect(live.editor.text()).toBe('- [x] one\n- two\n');
      expect(live.editor.exec('task')).toBe(true);
      expect(live.editor.text()).toBe('- one\n- [ ] two\n');
    } finally {
      live.dispose();
    }
  });

  it('keeps what was selected selected when it wraps it', async () => {
    for (const command of [
      'bold',
      'italic',
      'strike',
      'code',
      'highlight',
      'underline',
      'sub',
      'sup',
    ] as const) {
      const live = await openLive('say hello now');
      try {
        live.editor.restore({
          anchor: { line: 1, col: 5 },
          head: { line: 1, col: 10 },
          topLine: 1,
        });
        live.editor.exec(command);
        expect(live.editor.selectionMarkdown(), command).toBe('hello');
      } finally {
        live.dispose();
      }
    }
  });

  it('makes a table of 2 columns and a math block, and puts the caret in the callout and the math', async () => {
    const live = await openLive('text\n');
    try {
      live.editor.restore({ anchor: { line: 1, col: 5 }, head: { line: 1, col: 5 }, topLine: 1 });
      live.editor.exec('table');
      expect(live.editor.text()).toMatch(
        /^text\n\n\| {1,}\| {1,}\|\n\| :?-+ \| :?-+ \|\n\| {1,}\| {1,}\|\n$/,
      );
    } finally {
      live.dispose();
    }
    const math = await openLive('text\n');
    try {
      math.editor.restore({ anchor: { line: 1, col: 5 }, head: { line: 1, col: 5 }, topLine: 1 });
      math.editor.exec('math');
      expect(math.editor.text()).toBe('text\n\n$$\n$$\n');
      expect(math.editor.cursor().line).toBeGreaterThanOrEqual(3);
    } finally {
      math.dispose();
    }
  });

  it('clears the formatting of the block', async () => {
    const live = await openLive('## **bold** and ==hl==\n');
    try {
      live.editor.restore({ anchor: { line: 1, col: 4 }, head: { line: 1, col: 4 }, topLine: 1 });
      expect(live.editor.exec('clear')).toBe(true);
      expect(live.editor.text()).toBe('bold and hl\n');
    } finally {
      live.dispose();
    }
  });
});

// ---- the view: scroll and top line (a layout is stubbed: jsdom has none) --------------------------------

describe('the scroll of the view', () => {
  it('has the line at the top of the view in its snapshot, and scrolls back to it', async () => {
    const live = await openLive('one\n\ntwo\n\nthree\n\nfour\n');
    try {
      const view = EditorViewOf(live.editor);
      const second = posAfter(view.state.doc, 'three');
      // the point at the top of the editor is over "three", which is on line 5
      vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: second, inside: second - 1 });
      expect(live.editor.snapshot().topLine).toBe(5);
      vi.restoreAllMocks();

      let top = 0;
      Object.defineProperty(live.parent, 'scrollTop', {
        get: () => top,
        set: (v: number) => void (top = v),
        configurable: true,
      });
      vi.spyOn(live.parent, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
      vi.spyOn(view, 'coordsAtPos').mockReturnValue({ top: 540, bottom: 560, left: 0, right: 10 });
      live.editor.restore({ anchor: { line: 7, col: 1 }, head: { line: 7, col: 1 }, topLine: 5 });
      expect(top).toBe(440);
      // the top of the note is the top of the scroll, whatever the padding above its first block
      live.editor.restore({ anchor: { line: 1, col: 1 }, head: { line: 1, col: 1 }, topLine: 1 });
      expect(top).toBe(0);
    } finally {
      vi.restoreAllMocks();
      live.dispose();
    }
  });
});

describe('the emoji', () => {
  it('are drawn from the images the application serves, and written back as the characters they are', async () => {
    const raw = 'a 😀 and :smile: typed\n';
    const live = await openLive(raw);
    try {
      const img = live.parent.querySelector('img');
      expect(img?.getAttribute('src')).toBe('/emoji/svg/1f600.svg');
      expect(live.editor.text()).toBe(raw);
      expect(live.parent.innerHTML).not.toContain('jsdelivr');
    } finally {
      live.dispose();
    }
  });

  it('all have an image among the files the build copies (the names the parser makes are the names of the files)', async () => {
    // the files the build copies to `emoji/svg/` (copyTwemojiAssets, build/esbuild.mjs)
    const svg = join(
      dirname(createRequire(import.meta.url).resolve('@discordapp/twemoji/package.json')),
      'dist/svg',
    );
    const emoji = ['😀', '❤️', '👍🏽', '👨‍👩‍👧', '🇮🇹', '1️⃣', '🏳️‍🌈', '©️', '🧑‍💻'];
    const live = await openLive(`${emoji.join(' ')}\n`);
    try {
      const srcs = [...live.parent.querySelectorAll('img[title]')].map(
        (i) => i.getAttribute('src') ?? '',
      );
      expect(srcs).toHaveLength(emoji.length);
      for (const src of srcs) {
        expect(src).toMatch(/^\/emoji\/svg\/[0-9a-f-]+\.svg$/);
        expect(existsSync(join(svg, src.replace('/emoji/svg/', ''))), src).toBe(true);
      }
    } finally {
      live.dispose();
    }
  });
});
