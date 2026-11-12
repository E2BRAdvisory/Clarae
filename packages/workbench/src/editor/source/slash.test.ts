import { beforeAll, describe, expect, it } from 'vitest';
import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { initI18n } from '../../i18n';
import { filterItems, slashCompletionSource, slashItems, slashMatch, todayText } from './slash';

beforeAll(() => initI18n('en'));

const source = (enabled = true) =>
  slashCompletionSource({ enabled: () => enabled, run: () => undefined });

/** Runs the source with the caret at the "|" of `doc`. */
async function open(doc: string, enabled = true) {
  const pos = doc.indexOf('|');
  const text = doc.replace('|', '');
  const state = EditorState.create({
    doc: text,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const res = await source(enabled)(new CompletionContext(state, pos, false));
  return { res, state, pos };
}

describe('slash match', () => {
  it('needs a slash at the line start or after whitespace', () => {
    expect(slashMatch('/hea', 4)).toEqual({ query: 'hea', start: 0 });
    expect(slashMatch('some text /', 11)).toEqual({ query: '', start: 10 });
    expect(slashMatch('    /task', 9)).toEqual({ query: 'task', start: 4 });
    expect(slashMatch('and/or', 6)).toBeNull();
    expect(slashMatch('https://example.com/', 20)).toBeNull();
    expect(slashMatch('a /b c', 6)).toBeNull(); // the query ended at a space
  });

  it('filters by label and keywords, prefix matches first', () => {
    expect(filterItems('')).toHaveLength(slashItems.length);
    expect(filterItems('head').map((i) => i.id)).toEqual(['h1', 'h2', 'h3']);
    expect(filterItems('tabella').map((i) => i.id)).toContain('table'); // keywords include Italian
    expect(filterItems('zzzz')).toEqual([]);
  });
});

describe('slash menu', () => {
  it('opens at line start and after a space', async () => {
    expect((await open('/|')).res?.options.length).toBe(slashItems.length);
    const r = await open('some text /ca|');
    expect(r.res?.options.map((o) => o.label)).toEqual(['/Callout']);
    expect(r.res?.from).toBe(10);
  });

  it('stays quiet in code, frontmatter, math, URLs and inside words', async () => {
    expect((await open('```\n/|\n```')).res).toBeNull();
    expect((await open('use `a /|` here')).res).toBeNull();
    expect((await open('---\ntitle: x\n/|\n---\n')).res).toBeNull();
    expect((await open('$$\n/|\n$$')).res).toBeNull();
    expect((await open('inline $x /|')).res).toBeNull();
    expect((await open('see https://x.org/|')).res).toBeNull();
    expect((await open('either/|')).res).toBeNull();
  });

  it('is off when disabled or when the note is read-only', async () => {
    expect((await open('/|', false)).res).toBeNull();
    const state = EditorState.create({ doc: '/', extensions: [EditorState.readOnly.of(true)] });
    expect(await source()(new CompletionContext(state, 1, false))).toBeNull();
  });

  it('applies an item: removes the typed text and places the cursor', async () => {
    const { res, state } = await open('intro /call|');
    const view = new EditorView({ state, parent: document.body });
    const option = res?.options.find((o) => o.label === '/Callout') as Completion;
    (option.apply as (v: EditorView, c: Completion, a: number, b: number) => void)(
      view,
      option,
      res?.from ?? 0,
      state.doc.length,
    );
    // a block starts on a line of its own, whatever was in front of the slash
    expect(view.state.doc.toString()).toBe('intro \n> [!note] \n> ');
    expect(view.state.selection.main.head).toBe('intro \n> [!note] '.length);
    view.destroy();
  });

  it('inserts a table whole: its first pipe is not the place of the caret', async () => {
    const { res, state } = await open('/table|');
    const view = new EditorView({ state, parent: document.body });
    const option = res?.options.find((o) => o.label === '/Table') as Completion;
    (option.apply as (v: EditorView, c: Completion, a: number, b: number) => void)(
      view,
      option,
      0,
      state.doc.length,
    );
    expect(view.state.doc.toString()).toBe('| Column 1 | Column 2 |\n| --- | --- |\n| | |');
    view.destroy();
  });

  it("inserts today's date in local time", async () => {
    const { res, state } = await open('/date|');
    const view = new EditorView({ state, parent: document.body });
    const option = res?.options[0] as Completion;
    (option.apply as (v: EditorView, c: Completion, a: number, b: number) => void)(
      view,
      option,
      0,
      state.doc.length,
    );
    expect(view.state.doc.toString()).toBe(todayText());
    expect(todayText(new Date(2026, 2, 5))).toBe('2026-03-05');
    view.destroy();
  });

  it('applies an editor command item through the handle of the editor', async () => {
    const { res, state } = await open('some title /head|');
    const view = new EditorView({ state, parent: document.body });
    const option = res?.options.find((o) => o.label === '/Heading 2') as Completion;
    (option.apply as (v: EditorView, c: Completion, a: number, b: number) => void)(
      view,
      option,
      res?.from ?? 0,
      state.doc.length,
    );
    expect(view.state.doc.toString()).toBe('## some title ');
    view.destroy();
  });

  it('gives every item exactly one way to act, and only known editor commands', () => {
    for (const it of slashItems) {
      const ways = [it.insert !== undefined, it.command !== undefined, it.exec !== undefined];
      expect(ways.filter(Boolean), it.id).toHaveLength(1);
    }
    expect(slashItems.filter((it) => it.exec).map((it) => it.exec)).toEqual([
      'heading-1',
      'heading-2',
      'heading-3',
      'callout',
      'code-block',
      'table',
      'separator',
      'math',
      'wikilink',
      'embed',
    ]);
    // a snippet with the caret inside the syntax is a command of the editor, never text with a mark
    expect(slashItems.filter((it) => it.insert !== undefined).map((it) => it.id)).toEqual(['date']);
  });

  it('applies a registry command item through the host', async () => {
    const ran: string[] = [];
    const src = slashCompletionSource({ enabled: () => true, run: (id) => ran.push(id) });
    const state = EditorState.create({
      doc: '/task',
      extensions: [markdown({ base: markdownLanguage })],
    });
    const res = await src(new CompletionContext(state, 5, false));
    const view = new EditorView({ state, parent: document.body });
    const option = res?.options[0] as Completion;
    (option.apply as (v: EditorView, c: Completion, a: number, b: number) => void)(
      view,
      option,
      0,
      5,
    );
    expect(ran).toEqual(['editor:task']);
    expect(view.state.doc.toString()).toBe('');
    view.destroy();
  });
});
