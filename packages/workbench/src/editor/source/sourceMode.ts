// Source mode: the raw Markdown with syntax highlighting and Obsidian syntax
// marked (nothing is hidden or replaced).
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import type { Range } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { isValidTag, scanSpans, stripInlineCode, type BlockState } from '@clarae/markdown';
import { blockStateAt, blockStates } from './blockState';

export const markdownHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading1, class: 'cm-hl-h1' },
    { tag: t.heading2, class: 'cm-hl-h2' },
    { tag: t.heading3, class: 'cm-hl-h3' },
    { tag: [t.heading4, t.heading5, t.heading6], class: 'cm-hl-h4' },
    { tag: t.strong, class: 'cm-hl-strong' },
    { tag: t.emphasis, class: 'cm-hl-em' },
    { tag: t.strikethrough, class: 'cm-hl-strike' },
    { tag: [t.link, t.url], class: 'cm-hl-link' },
    { tag: t.monospace, class: 'cm-hl-code' },
    { tag: t.quote, class: 'cm-hl-quote' },
    { tag: [t.processingInstruction, t.contentSeparator], class: 'cm-hl-mark' },
    { tag: t.comment, class: 'cm-hl-comment' },
  ]),
);

const WIKILINK = /!?\[\[[^[\]]+?\]\]/g;
const HIGHLIGHT = /==(?=\S)[^\n]+?(?<=\S)==/g;
const TAG = /(^|[ \t\n\f\r([{,;])#([\p{L}\p{N}_\-/]+)/gu;
const BLOCK_ID = /[ \t]\^[A-Za-z0-9-]+[ \t]*$/;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>)]+/g;
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const out: Range<Decoration>[] = [];
  const mark = (from: number, to: number, cls: string): void =>
    void out.push(Decoration.mark({ class: cls }).range(from, to));
  const code = new Set<number>();
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock') {
        for (let l = state.doc.lineAt(n.from).number; l <= state.doc.lineAt(n.to).number; l++)
          code.add(l);
        return false;
      }
      return undefined;
    },
  });
  const fm = state.field(blockStates).frontmatterLines;
  for (const r of view.visibleRanges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (n <= fm || code.has(n)) continue;
      const line = state.doc.line(n);
      const st: BlockState = blockStateAt(state, n);
      let vis = stripInlineCode(line.text);
      for (const sp of scanSpans(vis, st)) {
        mark(
          line.from + sp.from,
          line.from + sp.to,
          sp.kind === 'comment' ? 'cm-hl-comment' : 'cm-hl-math',
        );
        vis = vis.slice(0, sp.from) + ' '.repeat(sp.to - sp.from) + vis.slice(sp.to);
      }
      for (const m of vis.matchAll(WIKILINK)) {
        if ((m.index ?? 0) > 0 && vis[(m.index ?? 0) - 1] === '\\') continue;
        mark(
          line.from + (m.index ?? 0),
          line.from + (m.index ?? 0) + m[0].length,
          'cm-hl-wikilink',
        );
      }
      const noWiki = vis.replace(WIKILINK, (s) => ' '.repeat(s.length));
      for (const m of noWiki.matchAll(HIGHLIGHT))
        mark(
          line.from + (m.index ?? 0),
          line.from + (m.index ?? 0) + m[0].length,
          'cm-hl-highlight',
        );
      const noUrl = noWiki
        .replace(URL_RE, (s) => ' '.repeat(s.length))
        .replace(MD_LINK, (s) => ' '.repeat(s.length));
      for (const m of noUrl.matchAll(TAG)) {
        const name = m[2] ?? '';
        if (!isValidTag(name)) continue;
        const s = line.from + (m.index ?? 0) + (m[1] ?? '').length;
        mark(s, s + 1 + name.length, 'cm-hl-tag');
      }
      const b = BLOCK_ID.exec(vis);
      if (b)
        mark(line.from + b.index + 1, line.from + b.index + b[0].trimEnd().length, 'cm-hl-blockid');
    }
  }
  return Decoration.set(out, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export function sourceMode() {
  return [blockStates, markdownHighlight, plugin];
}
