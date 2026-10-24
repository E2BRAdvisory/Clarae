import { describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { WidgetType } from '@codemirror/view';
import { blockDecorations, blockWidgets, scanBlocks } from './blockWidgets';
import { livePreview, buildInline } from './livePreview';
import { livePreviewContext, defaultContext } from './context';
import { toggleCallout } from './callouts';

function stateFor(
  doc: string,
  cursor = 0,
  resolved: (t: string) => boolean | undefined = () => true,
): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [
      markdown({ base: markdownLanguage }),
      livePreview(),
      blockWidgets(),
      livePreviewContext.of({ ...defaultContext, resolved }),
    ],
  });
}

interface D {
  from: number;
  to: number;
  kind: 'hide' | 'mark' | 'line' | 'widget';
  cls?: string;
  widget?: string;
}

function describe_(state: EditorState, doc = state.doc.toString()): D[] {
  const out: D[] = [];
  for (const r of buildInline(state, [{ from: 0, to: doc.length }])) {
    const spec = (r.value as unknown as { spec: Record<string, unknown> }).spec;
    const cls = spec['class'];
    const widget = spec['widget'] as WidgetType | undefined;
    if (widget)
      out.push({ from: r.from, to: r.to, kind: 'widget', widget: widget.constructor.name });
    else if (typeof cls === 'string')
      out.push({ from: r.from, to: r.to, kind: r.from === r.to ? 'line' : 'mark', cls });
    else out.push({ from: r.from, to: r.to, kind: 'hide' });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
const text = (doc: string, d: D): string => doc.slice(d.from, d.to);

describe('inline Live Preview', () => {
  it('hides heading, emphasis and code marks away from the caret and reveals them under it', () => {
    const doc = '# Title\n\nsome **bold** and *it* and `code`\n';
    const away = describe_(stateFor(doc, doc.length));
    expect(away.filter((d) => d.kind === 'hide').map((d) => text(doc, d))).toEqual([
      '# ',
      '**',
      '**',
      '*',
      '*',
      '`',
      '`',
    ]);
    expect(away.some((d) => d.cls === 'cm-lp-h cm-lp-h1')).toBe(true);
    // Caret inside the bold text reveals only its own marks.
    const inside = describe_(stateFor(doc, doc.indexOf('bold') + 1));
    expect(inside.filter((d) => d.kind === 'hide').map((d) => text(doc, d))).toEqual([
      '# ',
      '*',
      '*',
      '`',
      '`',
    ]);
  });

  it('renders wikilinks: brackets and target hidden when aliased, ghost links flagged', () => {
    const doc = 'See [[Note]] and [[Other|shown]] and [[Missing]]\n';
    const d = describe_(stateFor(doc, doc.length, (t) => t !== 'Missing'));
    const marks = d.filter((x) => x.kind === 'mark');
    expect(marks.map((x) => [text(doc, x), x.cls])).toEqual([
      ['Note', 'cm-wikilink'],
      ['shown', 'cm-wikilink'],
      ['Missing', 'cm-wikilink cm-wikilink-unresolved'],
    ]);
    const hidden = d.filter((x) => x.kind === 'hide').map((x) => text(doc, x));
    expect(hidden).toEqual(['[[', ']]', '[[Other|', ']]', '[[', ']]']);
  });

  it('shows raw wikilink syntax when the caret is inside', () => {
    const doc = 'a [[Note]] b\n';
    const d = describe_(stateFor(doc, doc.indexOf('Note') + 2));
    expect(d.filter((x) => x.kind === 'hide')).toEqual([]);
    expect(d.some((x) => x.cls === 'cm-lp-wikilink-raw')).toBe(true);
  });

  it('turns embeds, tasks, highlights, tags and block ids into widgets and marks', () => {
    const doc = '![[img.png|200]]\n- [ ] todo\n- [x] done\n==hot== #tag/sub text ^blk\n';
    const d = describe_(stateFor(doc, doc.length));
    expect(d.filter((x) => x.kind === 'widget').map((x) => x.widget)).toEqual(
      ['EmbedWidget', 'BulletWidget'].slice(0, 1).concat(['CheckboxWidget', 'CheckboxWidget']),
    );
    expect(d.some((x) => x.cls === 'cm-lp-task-done')).toBe(true);
    expect(d.find((x) => x.cls === 'cm-lp-highlight')).toBeTruthy();
    const tag = d.find((x) => x.cls === 'cm-lp-tag');
    expect(tag && text(doc, tag)).toBe('#tag/sub');
    const blk = d.find((x) => x.cls === 'cm-lp-blockid');
    expect(blk && text(doc, blk)).toBe('^blk');
  });

  it('applies the indexer rules: nothing inside code, comments or escaped brackets', () => {
    const doc =
      '`[[code]]` \\[[escaped]] %%[[hidden]] #h%% [[real]]\n\n```\n[[fence]] #nope\n```\n';
    const d = describe_(stateFor(doc, doc.length));
    const names = d.filter((x) => x.cls?.startsWith('cm-wikilink')).map((x) => text(doc, x));
    expect(names).toEqual(['real']);
    expect(d.filter((x) => x.cls === 'cm-lp-tag')).toEqual([]);
    // The comment is hidden entirely.
    expect(d.filter((x) => x.kind === 'hide').map((x) => text(doc, x))).toContain(
      '%%[[hidden]] #h%%',
    );
  });

  it('handles callouts and quotes', () => {
    const doc = '> [!warning] Careful\n> body text\n\n> plain quote\n';
    const d = describe_(stateFor(doc, doc.length));
    expect(d.filter((x) => x.cls === 'cm-lp-quote cm-callout cm-callout-warning')).toHaveLength(2);
    expect(d.some((x) => x.widget === 'CalloutTitleWidget')).toBe(true);
    expect(d.filter((x) => x.cls === 'cm-lp-quote')).toHaveLength(1);
  });

  it('keeps comments spanning lines hidden line by line', () => {
    const doc = 'before %%\nsecret [[x]]\n%% after [[ok]]\n';
    const d = describe_(stateFor(doc, doc.length));
    expect(d.filter((x) => x.cls?.startsWith('cm-wikilink')).map((x) => text(doc, x))).toEqual([
      'ok',
    ]);
    expect(d.filter((x) => x.kind === 'hide').map((x) => text(doc, x))).toEqual(
      expect.arrayContaining(['%%', 'secret [[x]]', '%%']),
    );
  });
});

describe('block widgets', () => {
  it('finds frontmatter, display math, mermaid and callout blocks', () => {
    const doc =
      '---\na: 1\n---\n$$\nx^2\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n\n> [!note]- Folded\n> hidden body\n';
    const blocks = scanBlocks(stateFor(doc));
    expect(blocks.map((b) => b.kind)).toEqual(['frontmatter', 'math', 'mermaid', 'callout']);
    expect(blocks[1]?.data).toBe('x^2');
    expect(blocks[2]?.data.trim()).toBe('graph TD; A-->B');
  });

  it('shows source when the caret is inside a block and folds callouts with the default marker', () => {
    const doc = '$$\nx\n$$\n\n> [!note]- Folded\n> body\n';
    const away = blockDecorations(stateFor(doc, doc.length));
    let n = 0;
    away.between(0, doc.length, () => void n++);
    expect(n).toBe(2); // math widget + folded callout body
    const inside = blockDecorations(stateFor(doc, 4));
    let m = 0;
    inside.between(0, doc.length, () => void m++);
    expect(m).toBe(1); // math is being edited; callout still folded
  });

  it('toggling flips the default fold state', () => {
    const doc = '> [!note]+ Open\n> body\n';
    let s = stateFor(doc, doc.length);
    const count = (st: EditorState): number => {
      let k = 0;
      blockDecorations(st).between(0, doc.length, () => void k++);
      return k;
    };
    expect(count(s)).toBe(0);
    s = s.update({ effects: toggleCallout.of(0) }).state;
    expect(count(s)).toBe(1);
  });
});
