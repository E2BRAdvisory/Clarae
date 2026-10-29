// Live Preview (ADR-0004): the Markdown is rendered in place and the syntax
// reappears where the caret is. Built on decorations over the @lezer/markdown
// tree (structure) plus a line scanner for Obsidian syntax (wikilinks, embeds,
// ==highlight==, %%comments%%, #tags, ^block ids, $math$) that uses the SAME
// rules as the indexer (@memobrain/markdown), so what is rendered as a link is
// exactly what the index counts as one.
//
// `buildInline` is pure (state in, ranges out) and is unit tested; the plugin
// only runs it for the visible viewport.
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { StateEffect, type EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  isValidTag,
  parseWikilinkInner,
  scanSpans,
  stripInlineCode,
  type BlockState,
} from '@memobrain/markdown';
import { blockStateAt, blockStates } from './blockState';
import { calloutToggles, isCalloutFolded, parseCalloutHead, toggleCallout } from './callouts';
import { livePreviewContext, type LivePreviewContext } from './context';
import {
  BulletWidget,
  CalloutTitleWidget,
  CheckboxWidget,
  EmbedWidget,
  ImageWidget,
  MathWidget,
  RuleWidget,
} from './widgets';

/** Dispatch to force decorations to rebuild after link resolution results changed. */
export const linkStatusChanged = StateEffect.define<null>();

const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/dg;
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>)]+/g;
const TAG = /(^|[ \t\n\f\r([{,;])#([\p{L}\p{N}_\-/]+)/gu;
const BLOCK_ID = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/;
const HIGHLIGHT = /==(?=\S)([^\n]+?)(?<=\S)==/g;
const INLINE_MATH = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g;
const FOOTREF = /\[\^[^\]\s]+\](?!:)/g;

const hideDeco = Decoration.replace({});

interface Ctx {
  state: EditorState;
  out: Range<Decoration>[];
  ctx: LivePreviewContext;
  /** True when a selection range touches [from, to]. */
  touches(from: number, to: number): boolean;
  /** True when a selection range sits on the line containing pos. */
  lineActive(pos: number): boolean;
}

function makeCtx(state: EditorState, out: Range<Decoration>[]): Ctx {
  const ranges = state.selection.ranges;
  return {
    state,
    out,
    ctx: state.facet(livePreviewContext),
    touches: (from, to) => ranges.some((r) => r.from <= to && r.to >= from),
    lineActive: (pos) => {
      const line = state.doc.lineAt(pos);
      return ranges.some((r) => r.from <= line.to && r.to >= line.from);
    },
  };
}

function hide(c: Ctx, from: number, to: number): void {
  if (from < to) c.out.push(hideDeco.range(from, to));
}
function mark(c: Ctx, from: number, to: number, cls: string, attrs?: Record<string, string>): void {
  if (from < to)
    c.out.push(
      Decoration.mark({ class: cls, ...(attrs ? { attributes: attrs } : {}) }).range(from, to),
    );
}
function lineClass(c: Ctx, pos: number, cls: string): void {
  c.out.push(Decoration.line({ class: cls }).range(c.state.doc.lineAt(pos).from));
}

/** Lines (numbers) covered by fenced or indented code in [from, to]. */
function codeLines(state: EditorState, from: number, to: number): Set<number> {
  const set = new Set<number>();
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const a = state.doc.lineAt(node.from).number;
        const b = state.doc.lineAt(node.to).number;
        for (let n = a; n <= b; n++) set.add(n);
        return false;
      }
      return undefined;
    },
  });
  return set;
}

function structural(c: Ctx, from: number, to: number): void {
  const { state } = c;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const name = node.name;
      let m: RegExpExecArray | null;
      if ((m = /^(?:ATX|Setext)Heading(\d)$/.exec(name))) {
        lineClass(c, node.from, `cm-lp-h cm-lp-h${m[1] ?? '1'}`);
        return undefined;
      }
      switch (name) {
        case 'HeaderMark': {
          const parent = node.node.parent;
          if (parent && parent.name.startsWith('ATXHeading') && !c.lineActive(node.from)) {
            const next = state.doc.sliceString(node.to, node.to + 1);
            hide(c, node.from, next === ' ' ? node.to + 1 : node.to);
          }
          return undefined;
        }
        case 'Emphasis':
          mark(c, node.from, node.to, 'cm-lp-em');
          return undefined;
        case 'StrongEmphasis':
          mark(c, node.from, node.to, 'cm-lp-strong');
          return undefined;
        case 'Strikethrough':
          mark(c, node.from, node.to, 'cm-lp-strike');
          return undefined;
        case 'InlineCode':
          mark(c, node.from, node.to, 'cm-lp-code');
          return undefined;
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark': {
          const parent = node.node.parent;
          if (parent && !c.touches(parent.from, parent.to)) hide(c, node.from, node.to);
          return undefined;
        }
        case 'Link': {
          const marks = node.node.getChildren('LinkMark');
          const url = node.node.getChild('URL');
          const href = url ? state.doc.sliceString(url.from, url.to) : '';
          const m0 = marks[0];
          const m1 = marks[1];
          // A bare "[text]" is a shortcut reference: that is how [[wikilinks]] parse, and
          // they are rendered by the Obsidian scanner below, so only real links count here.
          if (m0 && m1 && (url || node.node.getChild('LinkLabel'))) {
            if (c.touches(node.from, node.to)) {
              mark(c, node.from, node.to, 'cm-lp-link-raw');
            } else {
              hide(c, node.from, m0.to);
              mark(c, m0.to, m1.from, 'cm-lp-link', { 'data-url': href });
              hide(c, m1.from, node.to);
            }
          }
          return false;
        }
        case 'Autolink': {
          const url = node.node.getChild('URL');
          if (url) {
            const href = state.doc.sliceString(url.from, url.to);
            if (c.touches(node.from, node.to)) mark(c, node.from, node.to, 'cm-lp-link-raw');
            else {
              hide(c, node.from, url.from);
              mark(c, url.from, url.to, 'cm-lp-link', { 'data-url': href });
              hide(c, url.to, node.to);
            }
          }
          return false;
        }
        case 'URL': {
          // Bare GFM autolink (parent is not Link/Image/Autolink: those return false above).
          const href = state.doc.sliceString(node.from, node.to);
          mark(c, node.from, node.to, 'cm-lp-link', { 'data-url': href });
          return undefined;
        }
        case 'Image': {
          const marks = node.node.getChildren('LinkMark');
          const url = node.node.getChild('URL');
          const m0 = marks[0];
          const m1 = marks[1];
          if (url && m0 && m1 && !c.touches(node.from, node.to)) {
            const src = decodeURI(state.doc.sliceString(url.from, url.to));
            const alt = state.doc.sliceString(m0.to, m1.from);
            c.out.push(
              Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to),
            );
          }
          return false;
        }
        case 'Blockquote': {
          const first = state.doc.lineAt(node.from);
          const head =
            node.node.parent?.name === 'Blockquote' ? null : parseCalloutHead(first.text);
          const a = first.number;
          const b = state.doc.lineAt(node.to).number;
          for (let n = a; n <= b; n++) {
            const ln = state.doc.line(n);
            lineClass(
              c,
              ln.from,
              head ? `cm-lp-quote cm-callout cm-callout-${head.type}` : 'cm-lp-quote',
            );
          }
          if (head && !c.lineActive(first.from)) {
            const from = first.from + head.prefixLength;
            const folded = isCalloutFolded(state, first.from, head.marker);
            c.out.push(
              Decoration.replace({
                widget: new CalloutTitleWidget(
                  head.type,
                  head.title,
                  head.marker !== '',
                  folded,
                  first.from,
                  (view, pos) => view.dispatch({ effects: toggleCallout.of(pos) }),
                ),
              }).range(from, first.to),
            );
          }
          return undefined;
        }
        case 'QuoteMark':
          if (!c.lineActive(node.from)) {
            const next = state.doc.sliceString(node.to, node.to + 1);
            hide(c, node.from, next === ' ' ? node.to + 1 : node.to);
          }
          return undefined;
        case 'ListMark': {
          const text = state.doc.sliceString(node.from, node.to);
          if (!/^[-*+]$/.test(text)) return undefined;
          const item = node.node.parent;
          const hasTask = !!item?.getChild('Task');
          if (c.touches(node.from, node.to + 1)) return undefined;
          if (hasTask) hide(c, node.from, node.to + 1);
          else
            c.out.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
            );
          return undefined;
        }
        case 'TaskMarker': {
          const text = state.doc.sliceString(node.from, node.to); // "[x]"
          const st = text.charAt(1) || ' ';
          if (st !== ' ') lineClass(c, node.from, 'cm-lp-task-done');
          if (!c.touches(node.from, node.to)) {
            c.out.push(
              Decoration.replace({ widget: new CheckboxWidget(st, node.from) }).range(
                node.from,
                node.to,
              ),
            );
          }
          return undefined;
        }
        case 'HorizontalRule':
          if (!c.lineActive(node.from))
            c.out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          else lineClass(c, node.from, 'cm-lp-hr-line');
          return undefined;
        case 'FencedCode':
        case 'CodeBlock': {
          const a = state.doc.lineAt(node.from).number;
          const b = state.doc.lineAt(node.to).number;
          for (let n = a; n <= b; n++) {
            const cls = [
              'cm-lp-codeblock',
              n === a ? 'cm-lp-codeblock-first' : '',
              n === b ? 'cm-lp-codeblock-last' : '',
            ]
              .filter(Boolean)
              .join(' ');
            lineClass(c, state.doc.line(n).from, cls);
          }
          return false;
        }
        case 'Table': {
          const a = state.doc.lineAt(node.from).number;
          const b = state.doc.lineAt(node.to).number;
          for (let n = a; n <= b; n++)
            lineClass(
              c,
              state.doc.line(n).from,
              n === a ? 'cm-lp-table cm-lp-table-head' : 'cm-lp-table',
            );
          return undefined;
        }
        default:
          return undefined;
      }
    },
  });
}

/** Obsidian syntax on one line (outside code), using the indexer's rules. */
function ofmLine(c: Ctx, lineFrom: number, text: string, startState: BlockState): void {
  const st: BlockState = { ...startState };
  const clean0 = stripInlineCode(text);
  const spans = scanSpans(clean0, st);
  let visible = clean0;
  for (const sp of spans) {
    visible = visible.slice(0, sp.from) + ' '.repeat(sp.to - sp.from) + visible.slice(sp.to);
    const from = lineFrom + sp.from;
    const to = lineFrom + sp.to;
    if (sp.kind === 'comment') {
      if (c.touches(from, to)) mark(c, from, to, 'cm-lp-comment');
      else hide(c, from, to);
    } else if (sp.closed && !sp.continued) {
      // $$ … $$ within one line: inline display-style math widget unless being edited.
      const tex = text.slice(sp.from + 2, sp.to - 2);
      if (!c.touches(from, to))
        c.out.push(Decoration.replace({ widget: new MathWidget(tex, false) }).range(from, to));
      else mark(c, from, to, 'cm-lp-math-raw');
    }
  }

  // Wikilinks and embeds.
  for (const m of visible.matchAll(WIKILINK)) {
    const idx = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
    const [m0, m1] = idx[0] as [number, number];
    const [b0, b1] = idx[1] as [number, number];
    const [i0, i1] = idx[2] as [number, number];
    if (m0 > 0 && visible[m0 - 1] === '\\') continue;
    const p = parseWikilinkInner(visible.slice(i0, i1));
    const start = lineFrom + m0;
    const end = lineFrom + m1;
    const active = c.touches(start, end);
    if (b1 > b0) {
      const spec = {
        target: p.target,
        heading: p.heading,
        block: p.block,
        alias: p.alias,
        embed: true,
      };
      if (active) mark(c, start, end, 'cm-lp-wikilink-raw');
      else c.out.push(Decoration.replace({ widget: new EmbedWidget(spec) }).range(start, end));
      continue;
    }
    if (active) {
      mark(c, start, end, 'cm-lp-wikilink-raw');
      continue;
    }
    const target = p.target;
    const known = target ? c.ctx.resolved(target) : true;
    if (known === undefined && target) c.ctx.requestResolve(target);
    const cls = 'cm-wikilink' + (known === false ? ' cm-wikilink-unresolved' : '');
    const attrs = { 'data-target': target, 'data-heading': p.heading, 'data-block': p.block };
    const inner0 = lineFrom + i0;
    const inner1 = lineFrom + i1;
    if (p.alias) {
      const bar = visible.indexOf('|', i0);
      hide(c, start, lineFrom + bar + 1);
      mark(c, lineFrom + bar + 1, inner1, cls, attrs);
    } else {
      hide(c, start, inner0);
      mark(c, inner0, inner1, cls, attrs);
    }
    hide(c, inner1, end);
  }

  // Everything below must not see wikilinks, URLs or Markdown links.
  const noWiki = visible.replace(new RegExp(WIKILINK.source, 'g'), (s) => ' '.repeat(s.length));
  for (const m of noWiki.matchAll(HIGHLIGHT)) {
    const s = lineFrom + (m.index ?? 0);
    const e = s + m[0].length;
    if (c.touches(s, e)) mark(c, s, e, 'cm-lp-highlight');
    else {
      hide(c, s, s + 2);
      mark(c, s + 2, e - 2, 'cm-lp-highlight');
      hide(c, e - 2, e);
    }
  }
  for (const m of noWiki.matchAll(INLINE_MATH)) {
    const s = lineFrom + (m.index ?? 0);
    const e = s + m[0].length;
    if (!c.touches(s, e))
      c.out.push(Decoration.replace({ widget: new MathWidget(m[1] ?? '', false) }).range(s, e));
    else mark(c, s, e, 'cm-lp-math-raw');
  }
  for (const m of noWiki.matchAll(FOOTREF)) {
    const s = lineFrom + (m.index ?? 0);
    mark(c, s, s + m[0].length, 'cm-lp-footref');
  }
  const noUrl = noWiki
    .replace(URL_RE, (s) => ' '.repeat(s.length))
    .replace(MD_LINK, (s) => ' '.repeat(s.length));
  for (const m of noUrl.matchAll(TAG)) {
    const name = m[2] ?? '';
    if (!isValidTag(name)) continue;
    const s = lineFrom + (m.index ?? 0) + (m[1] ?? '').length;
    mark(c, s, s + 1 + name.length, 'cm-lp-tag', { 'data-tag': name });
  }
  const b = BLOCK_ID.exec(visible);
  if (b) {
    const s = lineFrom + (b.index ?? 0) + 1;
    mark(c, s, s + 1 + (b[1] ?? '').length, 'cm-lp-blockid');
  }
}

/** All Live Preview decorations for the given document ranges (pure). */
export function buildInline(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  const c = makeCtx(state, out);
  const fm = state.field(blockStates).frontmatterLines;
  for (const r of ranges) {
    const from = state.doc.lineAt(r.from).from;
    const to = state.doc.lineAt(Math.min(r.to, state.doc.length)).to;
    ensureSyntaxTree(state, to, 50);
    structural(c, from, to);
    const code = codeLines(state, from, to);
    for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
      if (n <= fm || code.has(n)) continue;
      const line = state.doc.line(n);
      ofmLine(c, line.from, line.text, blockStateAt(state, n));
    }
  }
  return out;
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(linkStatusChanged) || e.is(toggleCallout)),
        )
      ) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      return Decoration.set(buildInline(view.state, view.visibleRanges), true);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

/** Ctrl/Cmd+click on a rendered link opens it; a plain click just edits. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    const el = (event.target as HTMLElement).closest<HTMLElement>(
      '.cm-wikilink, .cm-lp-link, .cm-lp-tag',
    );
    if (!el) return false;
    const ctx = view.state.facet(livePreviewContext);
    if (el.classList.contains('cm-wikilink')) {
      ctx.openLink(
        {
          target: el.dataset['target'] ?? '',
          heading: el.dataset['heading'] ?? '',
          block: el.dataset['block'] ?? '',
          alias: '',
          embed: false,
        },
        event.altKey,
      );
    } else if (el.classList.contains('cm-lp-link')) {
      const url = el.dataset['url'] ?? '';
      if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(url)) ctx.openExternal(url);
      else
        ctx.openLink(
          {
            target: decodeURI(url.split('#')[0] ?? ''),
            heading: '',
            block: '',
            alias: '',
            embed: false,
          },
          event.altKey,
        );
    } else if (el.dataset['tag']) {
      ctx.openLink(
        {
          target: '',
          heading: '',
          block: '',
          alias: '#' + (el.dataset['tag'] ?? ''),
          embed: false,
        },
        false,
      );
    }
    event.preventDefault();
    return true;
  },
});

/** The Live Preview extension bundle (add the markdown language separately). */
export function livePreview() {
  return [blockStates, calloutToggles, livePreviewPlugin, linkClicks];
}
