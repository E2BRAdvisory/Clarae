// The behaviour every NoteEditorHandle must have, whatever engine is behind it. The suite takes a
// factory that builds an editor over a text (and puts the selection where the test says), and is run
// by handle.contract.test.ts once per adapter. Positions here are the ones of the source text:
// the contract does not know the engine, so it never looks inside it.
import { afterEach, describe, expect, it } from 'vitest';
import { headingCommand, type EditorCommand, type NoteEditorHandle } from './handle';

export interface HandleInit {
  doc: string;
  /** Offsets in `doc`; `head` defaults to `anchor` (a cursor). */
  selection?: { anchor: number; head?: number };
  readOnly?: boolean;
}

export interface HandleHarness {
  handle: NoteEditorHandle;
  /** Tears the editor down (listeners, DOM). */
  dispose(): void;
}

export type HandleFactory = (init: HandleInit) => HandleHarness | Promise<HandleHarness>;

/** `{ anchor, head }` that selects the first `word` of `doc`. */
export function select(doc: string, word: string): { anchor: number; head: number } {
  const at = doc.indexOf(word);
  if (at < 0) throw new Error(`"${word}" is not in the document`);
  return { anchor: at, head: at + word.length };
}

export interface ContractOptions {
  /**
   * The engine edits the source text line by line (CodeMirror): a command on 'one\ntwo' acts on each
   * line, a block the command inserts is the snippet's text. An engine that edits a document of blocks
   * (Milkdown) has the same commands with other results, and tests them in its own suite: it passes
   * `false` and the cases that depend on lines are skipped.
   */
  lineOriented?: boolean;
}

export function describeHandleContract(
  name: string,
  make: HandleFactory,
  options: ContractOptions = {},
): void {
  const lineOriented = options.lineOriented !== false;
  /** `it` for the cases that only hold for an engine that edits the source line by line. */
  const itLines: typeof it = ((...args: Parameters<typeof it>) =>
    (lineOriented ? it : it.skip)(...args)) as typeof it;
  const itLinesEach = ((cases: readonly unknown[]) =>
    lineOriented ? it.each(cases) : it.skip.each(cases)) as typeof it.each;
  const live: HandleHarness[] = [];
  const open = async (init: HandleInit): Promise<NoteEditorHandle> => {
    const h = await make(init);
    live.push(h);
    return h.handle;
  };
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  describe(`NoteEditorHandle contract: ${name}`, () => {
    const DOC = '# Title\n\nFirst line here\nSecond [[Note]] line\n\n- item\n';

    describe('reading the editor', () => {
      it('gives the whole source text', async () => {
        expect((await open({ doc: DOC })).text()).toBe(DOC);
      });

      it('gives the cursor as a 1-based line and column of the source', async () => {
        const at = DOC.indexOf('Second') + 3;
        const h = await open({ doc: DOC, selection: { anchor: at } });
        expect(h.cursor()).toEqual({ line: 4, col: 4 });
        // the start of a paragraph: col 1 (the start of a heading is after its `# ` in the source)
        const first = DOC.indexOf('First');
        expect((await open({ doc: DOC, selection: { anchor: first } })).cursor()).toEqual({
          line: 3,
          col: 1,
        });
      });

      it('gives the selection as source, and nothing for a cursor', async () => {
        expect(
          (await open({ doc: DOC, selection: select(DOC, 'First line') })).selectionMarkdown(),
        ).toBe('First line');
        expect((await open({ doc: DOC, selection: { anchor: 4 } })).selectionMarkdown()).toBe('');
      });

      it('tells whether the editor is read-only', async () => {
        expect((await open({ doc: DOC })).readOnly()).toBe(false);
        expect((await open({ doc: DOC, readOnly: true })).readOnly()).toBe(true);
      });

      it('has a root that holds the element that takes the focus, and focus() puts it there', async () => {
        const h = await open({ doc: DOC });
        expect(h.root.contains(h.focusElement)).toBe(true);
        h.focus();
        expect(document.activeElement).toBe(h.focusElement);
      });

      it('reports the mode it shows', async () => {
        expect(['source', 'live']).toContain((await open({ doc: DOC })).kind);
      });
    });

    describe('statistics', () => {
      it('counts words, characters and the position of the cursor', async () => {
        const doc = 'one two\nthree';
        const s = (await open({ doc, selection: { anchor: doc.length } })).stats();
        expect(s).toEqual({
          words: 3,
          chars: doc.length,
          selWords: 0,
          selChars: 0,
          line: 2,
          col: 6,
        });
      });

      it('counts the selection as selectionMarkdown() gives it', async () => {
        const doc = 'one two three four';
        const h = await open({ doc, selection: select(doc, 'two three') });
        expect(h.stats().selChars).toBe(h.selectionMarkdown().length);
        expect(h.stats()).toMatchObject({ selWords: 2, selChars: 'two three'.length });
      });

      it('gives the totals when everything is selected', async () => {
        const doc = 'one two three four';
        const h = await open({ doc, selection: { anchor: 0, head: doc.length } });
        const s = h.stats();
        expect(s.selWords).toBe(s.words);
        expect(s.selChars).toBe(s.chars);
      });
    });

    describe('replacing the selection', () => {
      it('replaces it and puts the caret after the new text', async () => {
        const h = await open({ doc: 'a SEL b', selection: select('a SEL b', 'SEL') });
        expect(h.replaceSelection('[[x]]')).toBe(true);
        expect(h.text()).toBe('a [[x]] b');
        expect(h.cursor()).toEqual({ line: 1, col: 8 });
      });

      it('inserts at a cursor, and puts the caret where it is asked to', async () => {
        const h = await open({ doc: 'ab', selection: { anchor: 1 } });
        h.replaceSelection('[[]]', { caret: 2 });
        expect(h.text()).toBe('a[[]]b');
        expect(h.cursor().col).toBe(4);
      });

      it('replaceSelectionIf only replaces a selection that still is what was expected', async () => {
        const doc = 'keep THIS here';
        const h = await open({ doc, selection: select(doc, 'THIS') });
        expect(h.replaceSelectionIf('THAT', 'x')).toBe(false);
        expect(h.text()).toBe(doc);
        expect(h.replaceSelectionIf('THIS', '[[Moved]]')).toBe(true);
        expect(h.text()).toBe('keep [[Moved]] here');
        expect(h.cursor().col).toBe('keep [[Moved]]'.length + 1);
      });

      it('is one undo step', async () => {
        const h = await open({ doc: 'a SEL b', selection: select('a SEL b', 'SEL') });
        h.replaceSelection('longer text');
        expect(h.exec('undo')).toBe(true);
        expect(h.text()).toBe('a SEL b');
      });
    });

    describe('appendToLine', () => {
      it('appends at the end of the given line, and only there', async () => {
        const h = await open({ doc: DOC });
        expect(h.appendToLine(3, ' ^abc123')).toBe(true);
        expect(h.text()).toBe(DOC.replace('First line here', 'First line here ^abc123'));
      });

      it('refuses a line that does not exist', async () => {
        const h = await open({ doc: 'one\ntwo' });
        expect(h.appendToLine(0, 'x')).toBe(false);
        expect(h.appendToLine(3, 'x')).toBe(false);
        expect(h.text()).toBe('one\ntwo');
      });
    });

    describe('applySourceEdits', () => {
      const base = 'alpha\nbeta\ngamma\n';

      it('applies the edits against the base text', async () => {
        const h = await open({ doc: base });
        const r = h.applySourceEdits(base, [
          { from: 0, to: 5, insert: 'ALPHA' },
          { from: base.length, insert: 'delta\n' },
          { from: 6, to: 11 },
        ]);
        expect(r).toBe('changed');
        expect(h.text()).toBe('ALPHA\ngamma\ndelta\n');
      });

      it('applies nothing when the text is no longer the base', async () => {
        const h = await open({ doc: base });
        expect(h.applySourceEdits('something else', [{ from: 0, insert: 'x' }])).toBe(false);
        expect(h.text()).toBe(base);
      });

      it('reports edits that leave the text as it was, and records no undo step', async () => {
        const h = await open({ doc: base });
        expect(h.applySourceEdits(base, [])).toBe('noop');
        expect(h.applySourceEdits(base, [{ from: 0, to: 5, insert: 'alpha' }])).toBe('noop');
        expect(h.text()).toBe(base);
        h.exec('undo');
        expect(h.text()).toBe(base);
      });

      it('is one undo step, however many edits it has', async () => {
        const h = await open({ doc: base });
        h.applySourceEdits(
          base,
          [
            { from: 0, insert: '> ' },
            { from: 6, insert: '> ' },
            { from: 11, insert: '> ' },
          ],
          'input.slides',
        );
        expect(h.text()).toBe('> alpha\n> beta\n> gamma\n');
        h.exec('undo');
        expect(h.text()).toBe(base);
        h.exec('redo');
        expect(h.text()).toBe('> alpha\n> beta\n> gamma\n');
      });
    });

    describe('exec', () => {
      it('wraps the selection and unwraps it again', async () => {
        const doc = 'say hello now';
        const h = await open({ doc, selection: select(doc, 'hello') });
        expect(h.exec('bold')).toBe(true);
        expect(h.text()).toBe('say **hello** now');
        expect(h.selectionMarkdown()).toBe('hello');
        h.exec('bold');
        expect(h.text()).toBe(doc);
      });

      itLines(
        'sets the heading level of the line, and the same level again removes it',
        async () => {
          const doc = 'plain\nnext';
          const h = await open({ doc, selection: { anchor: 2 } });
          h.exec('heading-2');
          expect(h.text()).toBe('## plain\nnext');
          h.exec('heading-3');
          expect(h.text()).toBe('### plain\nnext');
          h.exec('heading-3');
          expect(h.text()).toBe('plain\nnext');
        },
      );

      itLines('makes lists, quotes and tasks of the selected lines', async () => {
        const doc = 'one\ntwo';
        const h = await open({ doc, selection: { anchor: 0, head: doc.length } });
        h.exec('bullet');
        expect(h.text()).toBe('- one\n- two');
        h.exec('task');
        expect(h.text()).toBe('- [ ] one\n- [ ] two');
      });

      it('moves the item the selection is in up and down a list', async () => {
        const doc = '- a\n- b\n- c';
        const h = await open({ doc, selection: { anchor: 6 } });
        expect(h.exec('move-up')).toBe(true);
        expect(h.text()).toBe('- b\n- a\n- c');
        expect(h.exec('move-down')).toBe(true);
        expect(h.exec('move-down')).toBe(true);
        expect(h.text()).toBe('- a\n- c\n- b');
        // at the end of the list there is nothing to move past
        expect(h.exec('move-down')).toBe(false);
        expect(h.text()).toBe('- a\n- c\n- b');
      });

      itLines('inserts links, embeds and blocks at the selection', async () => {
        const h = await open({ doc: 'x ', selection: { anchor: 2 } });
        h.exec('wikilink');
        expect(h.text()).toBe('x [[]]');
        expect(h.cursor().col).toBe(5);
        const e = await open({ doc: '', selection: { anchor: 0 } });
        e.exec('embed');
        expect(e.text()).toBe('![[]]');
        const c = await open({ doc: '', selection: { anchor: 0 } });
        c.exec('code-block');
        expect(c.text()).toBe('```\n\n```');
      });

      // Every command of the handle, on the text it is meant for: what it writes, that it is one undo
      // step, and (for the toggles) that running it again takes it away.
      interface Case {
        command: EditorCommand;
        doc: string;
        selection: { anchor: number; head?: number };
        result: string;
        toggles?: boolean;
      }
      const word = (command: EditorCommand, open: string, close = open): Case => ({
        command,
        doc: 'say hello now',
        selection: select('say hello now', 'hello'),
        result: `say ${open}hello${close} now`,
        toggles: true,
      });
      const lines = (command: EditorCommand, result: string): Case => ({
        command,
        doc: 'one\ntwo',
        selection: { anchor: 0, head: 7 },
        result,
        toggles: true,
      });
      const heading = (level: number): Case => ({
        command: headingCommand(level),
        doc: 'plain',
        selection: { anchor: 2 },
        result: `${'#'.repeat(level)} plain`,
        toggles: true,
      });
      const CASES: Case[] = [
        word('strike', '~~'),
        word('underline', '<u>', '</u>'),
        word('highlight', '=='),
        word('code', '`'),
        word('comment', '%%'),
        word('sub', '<sub>', '</sub>'),
        word('sup', '<sup>', '</sup>'),
        {
          command: 'link',
          doc: 'say hello now',
          selection: select('say hello now', 'hello'),
          result: 'say [hello](url) now',
        },
        { command: 'link', doc: 'x ', selection: { anchor: 2 }, result: 'x [[]]' },
        lines('numbered', '1. one\n1. two'),
        lines('quote', '> one\n> two'),
        { command: 'callout', doc: '', selection: { anchor: 0 }, result: '> [!note] \n> ' },
        // A block starts on its own line: after text, it goes below it.
        {
          command: 'callout',
          doc: 'text',
          selection: { anchor: 4 },
          result: 'text\n> [!note] \n> ',
        },
        {
          command: 'table',
          doc: '',
          selection: { anchor: 0 },
          result: '| Column 1 | Column 2 |\n| --- | --- |\n| | |',
        },
        { command: 'math', doc: '', selection: { anchor: 0 }, result: '$$\n\n$$' },
        { command: 'math', doc: 'text', selection: { anchor: 4 }, result: 'text\n$$\n\n$$' },
        // A rule never turns the line above into a setext heading: a blank line goes between.
        { command: 'separator', doc: 'para', selection: { anchor: 2 }, result: 'para\n\n---\n' },
        { command: 'separator', doc: '', selection: { anchor: 0 }, result: '\n---\n' },
        ...[1, 2, 3, 4, 5, 6].map(heading),
      ];

      itLinesEach(CASES)('$command writes its markup on "$doc", in one undo step', async (c) => {
        const h = await open({ doc: c.doc, selection: c.selection });
        expect(h.exec(c.command)).toBe(true);
        expect(h.text()).toBe(c.result);
        expect(h.exec('undo')).toBe(true);
        expect(h.text()).toBe(c.doc);
      });

      itLinesEach(CASES.filter((c) => c.toggles))(
        '$command, run again on its own result, takes the markup away',
        async (c) => {
          const h = await open({ doc: c.doc, selection: c.selection });
          h.exec(c.command);
          h.exec(c.command);
          expect(h.text()).toBe(c.doc);
        },
      );

      itLines(
        'selects the url of a link made of the selection, ready to be typed over',
        async () => {
          const doc = 'say hello now';
          const h = await open({ doc, selection: select(doc, 'hello') });
          h.exec('link');
          expect(h.selectionMarkdown()).toBe('url');
        },
      );

      it('keeps the selected text selected when it wraps it', async () => {
        const doc = 'say hello now';
        // (a comment is a unit of its own in a block engine: it stays selected whole, as itself)
        const wrap = ['strike', 'underline', 'highlight', 'code', 'sub', 'sup'] as const;
        for (const command of lineOriented ? [...wrap, 'comment' as const] : wrap) {
          const h = await open({ doc, selection: select(doc, 'hello') });
          h.exec(command);
          expect(h.selectionMarkdown()).toBe('hello');
        }
      });

      itLines(
        'puts the cursor of a callout after its title marker and the one of a math block inside it',
        async () => {
          const callout = await open({ doc: '', selection: { anchor: 0 } });
          callout.exec('callout');
          expect(callout.cursor()).toEqual({ line: 1, col: 11 });
          const math = await open({ doc: '', selection: { anchor: 0 } });
          math.exec('math');
          expect(math.cursor()).toEqual({ line: 2, col: 1 });
        },
      );

      itLines('puts the cursor of a rule below it', async () => {
        const h = await open({ doc: 'para', selection: { anchor: 2 } });
        h.exec('separator');
        expect(h.cursor().line).toBeGreaterThan(3);
      });

      it('changes the level of a heading that has another one, whatever the levels', async () => {
        const h = await open({ doc: '#### deep', selection: { anchor: 6 } });
        h.exec('heading-1');
        expect(h.text()).toBe('# deep');
        h.exec('heading-6');
        expect(h.text()).toBe('###### deep');
      });

      it('clears the formatting of the line', async () => {
        const h = await open({ doc: '## **bold** and ==hl==', selection: { anchor: 3 } });
        expect(h.exec('clear')).toBe(true);
        expect(h.text()).toBe('bold and hl');
      });

      it('undoes and redoes', async () => {
        const h = await open({ doc: 'abc', selection: select('abc', 'b') });
        h.exec('italic');
        expect(h.text()).toBe('a*b*c');
        h.exec('undo');
        expect(h.text()).toBe('abc');
        h.exec('redo');
        expect(h.text()).toBe('a*b*c');
      });
    });

    describe('moving around', () => {
      it('reveals a line, a heading and a block', async () => {
        const doc = '# Intro\n\ntext\n\n## Part **Two**\n\nlast paragraph ^blk1\n';
        const h = await open({ doc });
        h.reveal({ line: 3 });
        expect(h.cursor()).toEqual({ line: 3, col: 1 });
        h.reveal({ heading: 'part two' });
        // (a heading's text starts after its `## ` in the source: the line is what is certain)
        expect(h.cursor().line).toBe(5);
        h.reveal({ block: 'blk1' });
        expect(h.cursor()).toEqual({ line: 7, col: 1 });
      });

      it('leaves the cursor where it is when the target is not there', async () => {
        const doc = '# A\n\ntext\n';
        const h = await open({ doc, selection: { anchor: 5 } });
        const before = h.cursor();
        h.reveal({ heading: 'Missing' });
        h.reveal({ block: 'nope' });
        h.reveal({ line: 99 });
        h.reveal({});
        expect(h.cursor()).toEqual(before);
      });

      it('goes to a line, clamped to the text', async () => {
        const h = await open({ doc: 'one\ntwo\nthree' });
        h.gotoLine(2);
        expect(h.cursor()).toEqual({ line: 2, col: 1 });
        h.gotoLine(99);
        expect(h.cursor()).toEqual({ line: 3, col: 1 });
        h.gotoLine(0);
        expect(h.cursor()).toEqual({ line: 1, col: 1 });
      });

      it('takes a snapshot of the selection and puts it back', async () => {
        const doc = 'one\ntwo three\nfour';
        const h = await open({ doc, selection: { anchor: 6, head: 9 } });
        const snap = h.snapshot();
        expect(snap.anchor).toEqual({ line: 2, col: 3 });
        expect(snap.head).toEqual({ line: 2, col: 6 });
        h.gotoLine(3);
        expect(h.selectionMarkdown()).toBe('');
        h.restore(snap);
        expect(h.selectionMarkdown()).toBe('o t');
        expect(h.snapshot().anchor).toEqual(snap.anchor);
      });

      it('takes the top line of the view as a line of the text', async () => {
        const doc = 'one\ntwo\nthree';
        const top = (await open({ doc })).snapshot().topLine;
        expect(Number.isInteger(top)).toBe(true);
        expect(top).toBeGreaterThanOrEqual(1);
        expect(top).toBeLessThanOrEqual(3);
      });

      it('puts back a cursor that is not a selection, and keeps the column', async () => {
        const doc = 'one\ntwo three\nfour';
        const h = await open({ doc, selection: { anchor: 8 } });
        const snap = h.snapshot();
        expect(snap.anchor).toEqual(snap.head);
        h.gotoLine(1);
        h.restore(snap);
        expect(h.cursor()).toEqual({ line: 2, col: 5 });
        expect(h.selectionMarkdown()).toBe('');
      });

      it('restores a snapshot of a longer text as far as the text goes', async () => {
        const h = await open({ doc: 'ab\ncd' });
        h.restore({ anchor: { line: 99, col: 99 }, head: { line: 2, col: 99 }, topLine: 99 });
        expect(h.snapshot().head).toEqual({ line: 2, col: 3 });
        expect(h.snapshot().anchor).toEqual({ line: 2, col: 3 });
        h.restore({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 2 }, topLine: 0 });
        expect(h.snapshot().anchor).toEqual({ line: 1, col: 1 });
        expect(h.selectionMarkdown()).toBe('a');
      });

      it('restores a view whose top line was somewhere in the text, whatever the lines are', async () => {
        const doc = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
        const h = await open({ doc, selection: { anchor: 0 } });
        expect(() =>
          h.restore({ anchor: { line: 40, col: 2 }, head: { line: 40, col: 2 }, topLine: 38 }),
        ).not.toThrow();
        expect(h.cursor()).toEqual({ line: 40, col: 2 });
      });
    });

    describe('links and search', () => {
      // Finding a link from a point of the screen needs a layout, which jsdom does not have: the
      // contract only has what holds without one (nothing under a point that is not on the text).
      // The hit from a point is checked by each adapter's own test, with a stubbed layout.
      it('finds no link at a point that is not over any text', async () => {
        const doc = 'plain text [[Note]]';
        expect((await open({ doc })).linkAt({ x: -10, y: -10 })).toBeNull();
      });

      it('finds the link under the cursor when it is anywhere inside the link, not outside', async () => {
        const doc = 'see [[Note]] and plain';
        // Outside, before, after and far from the link: never a hit.
        for (const at of [0, 2, doc.indexOf(' and') + 2, doc.length]) {
          expect((await open({ doc, selection: { anchor: at } })).linkAt('cursor')).toBeNull();
        }
      });

      it('finds no link where the cursor is not on one', async () => {
        const doc = 'plain text [[Note]]';
        expect((await open({ doc, selection: { anchor: 2 } })).linkAt('cursor')).toBeNull();
      });

      it('opens the find bar without failing', async () => {
        const h = await open({ doc: DOC });
        expect(() => h.openSearch()).not.toThrow();
      });
    });
  });
}
