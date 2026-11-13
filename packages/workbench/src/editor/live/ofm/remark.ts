// The remark plugin of the Live editor (A-D3, A-D4): it runs FIRST, before every other transformer,
// on the mdast of one document and its source text, and makes the tree say exactly what the file says.
//
//  1. What has no ProseMirror schema, or that the schema cannot write back, becomes a RAW node that
//     keeps the source text: link definitions and references, HTML, setext headings, indented code,
//     footnote definitions, autolinks, character references, tables with a cell the editor cannot
//     project, and every block touched by a multi-line %%comment%% or $$math$$.
//  2. The Obsidian constructs are projected onto the tree: the spans come from `scanBody`, the very
//     scanner of the indexer (B1), run on the whole source lines, and are placed on the mdast nodes
//     by `position`: wikilinks and embeds, tags, ^block ids, ==highlights==, inline comments, inline
//     footnotes. A span that cannot be placed exactly makes its block raw: the editor never shows
//     (or writes) a construct differently from the index.
//
// Where the editor cannot hold a block, the block is kept whole and byte for byte: it is never
// "almost" projected.
import { scanBody } from '@clarae/markdown';
import { InitReady, remarkPluginsCtx, schemaCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { decodeText, entitiesIn, insideConstruct, matchesValue } from './decode';
import { liveOptions } from './options';
import { MDAST } from './nodes';

interface Point {
  line: number;
  column: number;
  offset: number;
}

/** A mdast node, as loosely typed as this plugin needs. */
interface N {
  type: string;
  value?: string;
  children?: N[];
  position?: { start: Point; end: Point } | undefined;
  [key: string]: unknown;
}

const start = (n: N): number => n.position?.start.offset ?? -1;
const end = (n: N): number => n.position?.end.offset ?? -1;

type Kind = 'wikilink' | 'tag' | 'blockId' | 'highlight' | 'comment' | 'math' | 'footnoteInline';

interface Abs {
  kind: Kind | 'entity';
  from: number;
  to: number;
}

const ATOMIC = new Set<Abs['kind']>([
  'wikilink',
  'tag',
  'blockId',
  'comment',
  'math',
  'footnoteInline',
  'entity',
]);

/** The OFM spans of a body, with absolute offsets; the multi-line comments and math apart. */
function collect(src: string): { inline: Abs[]; multi: Abs[] } {
  const scan = scanBody(src);
  const inline: Abs[] = [];
  const multi: Abs[] = [];
  let open: Abs | null = null;
  scan.spans.forEach((line, i) => {
    const base = scan.starts[i] ?? 0;
    for (const sp of line) {
      switch (sp.kind) {
        case 'comment':
        case 'math': {
          const from = base + sp.from;
          const to = base + sp.to;
          if (sp.continued && open && open.kind === sp.kind) {
            open.to = to;
          } else {
            open = { kind: sp.kind, from, to };
            inline.push(open);
          }
          if (sp.closed) open = null;
          break;
        }
        case 'wikilink':
        case 'tag':
        case 'blockId':
        case 'highlight':
        case 'footnoteInline':
          inline.push({ kind: sp.kind, from: base + sp.from, to: base + sp.to });
          break;
        default:
          break;
      }
    }
  });
  const single: Abs[] = [];
  for (const s of inline) {
    if ((s.kind === 'comment' || s.kind === 'math') && src.slice(s.from, s.to).includes('\n')) {
      multi.push(s);
    } else {
      single.push(s);
    }
  }
  return { inline: single, multi };
}

function pos(from: number, to: number, a: N, b: N): { start: Point; end: Point } {
  return {
    start: { ...(a.position?.start ?? { line: 1, column: 1, offset: from }), offset: from },
    end: { ...(b.position?.end ?? { line: 1, column: 1, offset: to }), offset: to },
  };
}

class Transformer {
  private readonly inline: Abs[];
  private readonly multi: Abs[];

  constructor(
    private readonly src: string,
    private readonly forceRaw: ReadonlySet<number>,
    private readonly imageBlock: boolean,
  ) {
    const c = collect(src);
    this.inline = c.inline;
    this.multi = c.multi;
  }

  // ------------------------------------------------------------------ raw nodes

  /**
   * The source of [from, to) as the content of a raw node: for a block inside a container the
   * container prefix of the lines is dropped (the container writes it again); at the top level the
   * lines are what the file has.
   */
  private rawText(from: number, to: number, nested: boolean): string {
    const slice = this.src.slice(from, to);
    if (!nested || !slice.includes('\n')) return slice;
    const lineStart = this.src.lastIndexOf('\n', from - 1) + 1;
    // what precedes the node on its first line: list markers become the indentation of the next lines
    const before = this.src
      .slice(lineStart, from)
      .replace(/(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?/g, (m) => ' '.repeat(m.length));
    if (before === '') return slice;
    const lines = slice.split('\n');
    return lines.map((l, i) => (i === 0 ? l : stripPrefix(l, before))).join('\n');
  }

  private rawBlock(a: N, b: N = a, nested = true): N {
    const from = start(a);
    const to = end(b);
    return {
      type: MDAST.rawBlock,
      value: this.rawText(from, to, nested),
      position: pos(from, to, a, b),
    };
  }

  private rawInline(from: number, to: number, a: N, b: N = a): N {
    return {
      type: MDAST.rawInline,
      value: this.src.slice(from, to),
      position: pos(from, to, a, b),
    };
  }

  // ------------------------------------------------------------------ blocks

  /** Walks the block children of `parent`; true when `parent` itself must become raw in ITS parent. */
  walk(parent: N): boolean {
    let kids = parent.children ?? [];

    // 1. multi-line comments and math: the blocks they touch are kept whole
    const a = start(parent);
    const b = end(parent);
    for (const r of this.multi) {
      if (r.to <= a || r.from >= b) continue;
      const idx: number[] = [];
      kids.forEach((k, i) => {
        if (end(k) > r.from && start(k) < r.to) idx.push(i);
      });
      if (idx.length === 0) continue;
      const first = kids[idx[0]!]!;
      const last = kids[idx[idx.length - 1]!]!;
      if (idx.length === 1) {
        if (first.type === MDAST.rawBlock) continue;
        if (first.type === 'math' && start(first) === r.from && end(first) === r.to) continue;
        if (isContainer(first) && start(first) <= r.from && end(first) >= r.to) continue;
      }
      if (parent.type === 'list') return true;
      kids = [
        ...kids.slice(0, idx[0]),
        this.rawBlock(first, last, parent.type !== 'root'),
        ...kids.slice(idx[idx.length - 1]! + 1),
      ];
    }
    parent.children = kids;

    // 2. every child by its kind
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      const raw = this.block(parent, k);
      if (raw === 'escalate') return true;
      if (raw) kids[i] = raw;
    }

    // 3. a list item holds a paragraph first (the schema's rule): anything else keeps the list raw
    if (parent.type === 'listItem') {
      const first = kids[0];
      if (first && first.type !== 'paragraph') return true;
    }
    return false;
  }

  /** Handles one block child: returns a replacement, 'escalate' (the parent must go raw) or undefined. */
  private block(parent: N, k: N): N | 'escalate' | undefined {
    const nested = parent.type !== 'root';
    if (this.forceRaw.has(start(k)) && k.type !== MDAST.rawBlock && k.type !== 'listItem') {
      return this.rawBlock(k, k, nested);
    }
    switch (k.type) {
      case MDAST.rawBlock:
        return undefined;
      case 'definition':
      case 'footnoteDefinition':
      case 'html':
      case 'yaml':
      case 'toml':
        return this.rawBlock(k, k, nested);
      case 'thematicBreak':
        return undefined;
      case 'code':
        return this.code(k, nested);
      case 'math':
        return this.math(k, nested);
      case 'heading': {
        if (!/^[ \t]{0,3}#/.test(this.src.slice(start(k)))) return this.rawBlock(k, k, nested); // setext
        return this.leaf(k) ? undefined : this.rawBlock(k, k, nested);
      }
      case 'paragraph': {
        if (!this.leaf(k)) return this.rawBlock(k, k, nested);
        // a paragraph that is one image is the image block (what Crepe's own plugin would make of it,
        // but with the position, which the block table needs)
        const only = k.children?.length === 1 ? k.children[0] : undefined;
        if (this.imageBlock && only?.type === 'image') {
          return {
            type: 'image-block',
            url: only['url'],
            alt: only['alt'],
            title: only['title'],
            position: k.position,
          };
        }
        return undefined;
      }
      case 'table': {
        for (const row of k.children ?? []) {
          for (const cell of row.children ?? []) {
            if (!this.leaf(cell)) return this.rawBlock(k, k, nested);
          }
        }
        return undefined;
      }
      case 'blockquote':
        return this.walk(k) ? this.rawBlock(k, k, nested) : undefined;
      case 'list': {
        if (parent.type === 'list') return this.rawBlock(k, k, nested);
        return this.walk(k) ? this.rawBlock(k, k, nested) : undefined;
      }
      case 'listItem':
        return this.walk(k) ? 'escalate' : undefined;
      default:
        return this.rawBlock(k, k, nested);
    }
  }

  private code(k: N, nested: boolean): N | undefined {
    if (!/^[ \t]{0,3}(?:`{3,}|~{3,})/.test(this.src.slice(start(k))))
      return this.rawBlock(k, k, nested); // indented
    return undefined;
  }

  /** A `$$` block becomes the code block the Latex feature edits, remembering its form. */
  private math(k: N, nested: boolean): N | undefined {
    if (typeof k['meta'] === 'string' && k['meta'] !== '') return this.rawBlock(k, k, nested);
    k.type = 'code';
    k['lang'] = 'LaTeX';
    k['ofmForm'] = 'math';
    return undefined;
  }

  // ------------------------------------------------------------------ text blocks

  /** Projects the inline constructs of a paragraph, heading or table cell; false: it cannot be held. */
  private leaf(leaf: N): boolean {
    // ProseMirror marks do not nest: `*a *b* c*` would be written back as `*a b c*`
    if (nestsSameMark(leaf, [])) return false;
    const a = start(leaf);
    const b = end(leaf);
    const spans: Abs[] = [];
    for (const s of this.inline) {
      if (s.to <= a || s.from >= b) continue;
      if (s.from < a || s.to > b) return false; // crosses the edge of the block
      spans.push(s);
    }
    // the first character of the content (a heading's `#`s and the blanks of a cell are not)
    const lo =
      start(leaf) +
      (/^[ \t]{0,3}#{1,6}[ \t]*|^[ \t]*/.exec(this.src.slice(start(leaf), end(leaf)))?.[0].length ??
        0);
    const out = this.level(leaf.children ?? [], spans, lo, b);
    if (!out) return false;
    leaf.children = out;
    return true;
  }

  /**
   * One level of phrasing nodes with the spans that fall in them. Returns the new children, or
   * null when some span cannot be placed exactly.
   */
  private level(input: N[], spans: Abs[], lo: number | undefined, hi: number): N[] | null {
    if (!this.tile(input, lo, hi)) return null;
    const kids = input.map((k) => this.special(k));

    // spans strictly inside one child belong to it (or to nothing: code, HTML, a destination)
    const mine: Abs[] = [];
    const inner = new Map<N, Abs[]>();
    for (const s of spans) {
      const owner = kids.find(
        (k) =>
          k.type !== 'text' &&
          start(k) <= s.from &&
          s.to <= end(k) &&
          (start(k) < s.from || s.to < end(k)),
      );
      if (!owner) {
        mine.push(s);
      } else if (owner.children && owner.type !== MDAST.rawInline) {
        const list = inner.get(owner) ?? [];
        list.push(s);
        inner.set(owner, list);
      } // else: consumed by an atom (inline code, raw, image, break)
    }
    for (const k of kids) {
      if (!k.children || k.type === MDAST.rawInline) continue;
      const sub = this.level(k.children, inner.get(k) ?? [], undefined, end(k));
      if (!sub) return null;
      k.children = sub;
    }

    // character references are atoms too
    for (const k of kids) {
      if (k.type !== 'text') continue;
      const a = start(k);
      const slice = this.src.slice(a, end(k));
      for (const m of entitiesIn(slice)) {
        mine.push({ kind: 'entity', from: a + m.index, to: a + m.index + m.length });
      }
    }
    if (mine.length === 0) return kids;
    return this.place(kids, mine);
  }

  /**
   * The nodes made by a remark transform instead of the parser (the autolinks of GFM, `www.x.org`)
   * have no position: they get the one the source gives them, in order, or the block is kept raw.
   */
  private tile(kids: N[], lo: number | undefined, hi: number): boolean {
    if (kids.every((k) => k.position?.start.offset !== undefined)) return true;
    let at = lo ?? -1;
    for (const k of kids) {
      if (k.position?.start.offset !== undefined) {
        if (at >= 0 && start(k) < at) return false;
        at = end(k);
        continue;
      }
      if (at < 0) return false;
      let to = -1;
      if (k.type === 'text') {
        const value = k.value ?? '';
        for (let j = at + value.length; j <= hi && to < 0; j++) {
          if (decodeText(this.src.slice(at, j)) === value) to = j;
        }
      } else if (k.type === 'link') {
        const label = (k.children ?? []).map((c) => c.value ?? '').join('');
        if (label !== '' && this.src.startsWith(label, at)) to = at + label.length;
      }
      if (to < 0) return false;
      k.position = {
        start: { line: 1, column: 1, offset: at },
        end: { line: 1, column: 1, offset: to },
      };
      at = to;
    }
    return true;
  }

  /** Links, images, HTML and references that the editor writes back differently stay as source. */
  private special(k: N): N {
    const from = start(k);
    const to = end(k);
    switch (k.type) {
      case 'html':
      case 'linkReference':
      case 'imageReference':
      case 'footnoteReference':
        return this.rawInline(from, to, k);
      case 'link': {
        const text = this.src.slice(from, to);
        if (!text.startsWith('[') || text.startsWith('[]') || !canonicalDestination(text)) {
          return this.rawInline(from, to, k);
        }
        return k;
      }
      case 'image': {
        const text = this.src.slice(from, to);
        if (
          !text.startsWith('![') ||
          /\\[!-/:-@[-`{-~]|&(?:#\w+|\w+);/.test(text) ||
          !canonicalDestination(text)
        ) {
          return this.rawInline(from, to, k);
        }
        return k;
      }
      default:
        return k;
    }
  }

  /** Cuts the text nodes at the span boundaries and replaces what the spans cover. */
  private place(kids: N[], spans: Abs[]): N[] | null {
    // containment tree: a span partly over another one cannot be placed
    const sorted = [...spans].sort((x, y) => x.from - y.from || y.to - x.to);
    interface SpanNode {
      span: Abs;
      kids: SpanNode[];
    }
    const roots: SpanNode[] = [];
    const stack: SpanNode[] = [];
    for (const s of sorted) {
      while (stack.length > 0 && stack[stack.length - 1]!.span.to <= s.from) stack.pop();
      const top = stack[stack.length - 1];
      if (top && s.to > top.span.to) return null; // partial overlap
      const node: SpanNode = { span: s, kids: [] };
      if (top) {
        if (ATOMIC.has(top.span.kind)) continue; // swallowed by an atom
        top.kids.push(node);
      } else {
        roots.push(node);
      }
      stack.push(node);
    }

    // cut points
    const cuts = new Set<number>();
    const gather = (nodes: SpanNode[]): void => {
      for (const n of nodes) {
        cuts.add(n.span.from);
        cuts.add(n.span.to);
        if (n.span.kind === 'highlight') {
          cuts.add(n.span.from + 2);
          cuts.add(n.span.to - 2);
        }
        gather(n.kids);
      }
    };
    gather(roots);

    interface Piece {
      node: N;
      from: number;
      to: number;
    }
    const pieces: Piece[] = [];
    for (const k of kids) {
      const a = start(k);
      const b = end(k);
      const here = [...cuts].filter((p) => p > a && p < b).sort((x, y) => x - y);
      if (here.length === 0 || k.type !== 'text') {
        if (here.length > 0) return null; // a boundary inside a node that is not text
        pieces.push({ node: k, from: a, to: b });
        continue;
      }
      const slice = this.src.slice(a, b);
      if (!matchesValue(slice, k.value ?? '')) return null;
      let at = a;
      for (const p of [...here, b]) {
        if (insideConstruct(slice, p - a) && p !== b) return null;
        const part = this.src.slice(at, p);
        pieces.push({
          node: { type: 'text', value: decodeText(part), position: pos(at, p, k, k) },
          from: at,
          to: p,
        });
        at = p;
      }
    }

    const assemble = (items: Piece[], nodes: SpanNode[]): N[] | null => {
      const out: N[] = [];
      let i = 0;
      for (const sn of nodes) {
        const { from, to } = sn.span;
        while (i < items.length && items[i]!.to <= from) out.push(items[i++]!.node);
        let j = i;
        while (j < items.length && items[j]!.from < to) j++;
        const covered = items.slice(i, j);
        if (covered.some((c) => c.from < from || c.to > to)) return null;
        if (ATOMIC.has(sn.span.kind)) {
          out.push(this.atom(sn.span, covered));
        } else {
          // ==highlight==: the delimiters are the first and last pieces
          const open = covered[0];
          const close = covered[covered.length - 1];
          if (
            !open ||
            !close ||
            covered.length < 3 ||
            this.src.slice(open.from, open.to) !== '==' ||
            this.src.slice(close.from, close.to) !== '=='
          ) {
            return null;
          }
          const content = assemble(covered.slice(1, -1), sn.kids);
          if (!content) return null;
          out.push({
            type: MDAST.highlight,
            children: content,
            position: pos(from, to, covered[0]!.node, close.node),
          });
        }
        i = j;
      }
      while (i < items.length) out.push(items[i++]!.node);
      return out;
    };
    return assemble(pieces, roots);
  }

  private atom(s: Abs, covered: { node: N }[]): N {
    const first = covered[0]?.node ?? { type: 'text' };
    const last = covered[covered.length - 1]?.node ?? first;
    const text = this.src.slice(s.from, s.to);
    const position = pos(s.from, s.to, first, last);
    switch (s.kind) {
      case 'wikilink': {
        const embed = text.startsWith('!');
        return {
          type: MDAST.wikilink,
          value: text.slice(embed ? 3 : 2, -2),
          embed,
          position,
        };
      }
      case 'tag':
        return { type: MDAST.tag, value: text, position };
      case 'blockId':
        return { type: MDAST.blockId, value: text, position };
      default: // comment, math, footnoteInline, entity
        return { type: MDAST.rawInline, value: text, position };
    }
  }
}

const MARKS = new Set(['emphasis', 'strong', 'delete', 'link']);

/** True when an emphasis, strong, delete or link has one of the same kind inside it, at any depth. */
function nestsSameMark(n: N, open: string[]): boolean {
  for (const c of n.children ?? []) {
    if (MARKS.has(c.type)) {
      if (open.includes(c.type)) return true;
      if (nestsSameMark(c, [...open, c.type])) return true;
    } else if (nestsSameMark(c, open)) {
      return true;
    }
  }
  return false;
}

function isContainer(k: N): boolean {
  return k.type === 'blockquote' || k.type === 'list' || k.type === 'listItem';
}

/**
 * True when a link or an image is written `[text](dest)` or `[text](dest "title")` with a plain
 * destination (no spaces, parentheses, angle brackets, escapes or character references): the only
 * form the Markdown serializer writes back as it was, and the one the index reads (its link rule
 * does not know about the others).
 */
function canonicalDestination(link: string): boolean {
  const at = link.lastIndexOf('](');
  if (at < 0 || !link.endsWith(')')) return false;
  const dest = link.slice(at + 2, -1);
  return /^[^\s()<>\\]+(?: "[^"\\\n]*")?$/.test(dest) && !/&(?:#\w+|\w+);/.test(dest);
}

/** Removes from a continuation line as much of the container prefix as it has. */
function stripPrefix(line: string, prefix: string): string {
  let i = 0;
  for (const ch of prefix) {
    if (ch === '>') {
      if (line[i] === '>') {
        i++;
        if (line[i] === ' ') i++;
      } else break;
    } else if (ch === ' ' || ch === '\t') {
      if (line[i] === ' ' || line[i] === '\t') i++;
    }
  }
  return line.slice(i);
}

/**
 * Registers the transformer as the FIRST remark plugin (`$remark` appends): the others, the ones of
 * the presets included, must see the tree after the raw nodes are in.
 */
export const remarkLivePlugin: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(InitReady);
  const attacher = () => (tree: N, file: { value?: unknown }) => {
    const src = typeof file.value === 'string' ? file.value : '';
    const imageBlock = Boolean(ctx.get(schemaCtx).nodes['image-block']);
    new Transformer(src, ctx.get(liveOptions.key).forceRaw, imageBlock).walk(tree);
  };
  const entry = { plugin: attacher as never, options: undefined as never };
  ctx.update(remarkPluginsCtx, (list) => [entry, ...list]);
  return () => {
    ctx.update(remarkPluginsCtx, (list) => list.filter((x) => x !== entry));
  };
};
