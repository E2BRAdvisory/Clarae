// The composition (A-D3): the Markdown of the edited document, built from the block table.
//
// A block that is the same as at loading is its original text, byte for byte (blank lines and the
// separators between blocks too). Only a block that changed is written again: alone, with the style of
// the file (style.ts) and the indentation of the place it is in. Inside a list, a blockquote or a
// callout the same is done one level down, so ticking one task of a list of 200 items changes one line.
//
// A block is "the same" by identity first (ProseMirror shares what an edit did not touch) and then by
// equality that ignores what is not written (the heading ids, the numbers of list items).
import { Mark, type Node as PMNode } from '@milkdown/kit/prose/model';
import { childrenOf, KINDS, type BlockTable, type Entry } from './table';
import type { Style } from './style';
import { extract } from '@clarae/markdown';
import { prepareSource } from '../../../reading/render';

export interface ComposeOptions {
  /** Write every block again (the test of the layer: nothing may depend on the original text). */
  forceDirty?: boolean;
}

export interface Composer {
  /** The body (LF) of `doc`, an edit of `table.doc`. */
  compose(table: BlockTable, doc: PMNode, opts?: ComposeOptions): string;
  /** One block written alone with the style, as a dirty block is. */
  fresh(node: PMNode, style: Style, wrap?: { parent: PMNode; index: number }): string;
  /**
   * The top-level blocks that are not the same note once written again: their start offsets, to
   * keep them raw. A block is stable when the block written alone has the same Markdown tree (what
   * Reading shows) and the same index entry (`extract`) as the text the file has for it. What
   * breaks it is rare and local (`*[a*](b)`, a table padded for the index, a tab inside an item),
   * and it is exactly what an edit of the block would silently change.
   */
  unstableBlocks(table: BlockTable): Set<number>;
}

/** The attributes that are view state, not Markdown: they never make a block "changed". */
const NOT_WRITTEN: Record<string, readonly string[]> = {
  heading: ['id'],
  list_item: ['label'],
};

function semanticEq(a: PMNode, b: PMNode): boolean {
  if (a === b || a.eq(b)) return true;
  if (a.type !== b.type || a.isText || a.childCount !== b.childCount) return false;
  if (!Mark.sameSet(a.marks, b.marks)) return false;
  const skip = NOT_WRITTEN[a.type.name] ?? [];
  for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (!skip.includes(k) && a.attrs[k] !== b.attrs[k]) return false;
  }
  for (let i = 0; i < a.childCount; i++) {
    if (!semanticEq(a.child(i), b.child(i))) return false;
  }
  return true;
}

/**
 * The entry of the file that each block of `newMid` (the blocks of the document a window writes again,
 * from the block `from`) is the same as, or undefined. The blocks the edit left where they were
 * (`anchor`: the first p and the last s of the document) are paired by their place; the others, in
 * order, with what is left of the entries between the blocks that are paired. Two equal blocks (a
 * paragraph copied) are so told apart: the indentation of a block of the file goes with the block
 * that is the file's own, not with its copy.
 */
function pairBlocks(
  t: BlockTable,
  kids: PMNode[],
  newMid: PMNode[],
  oldMid: Entry[],
  from: number,
  anchor: { p: number; s: number },
): (Entry | undefined)[] {
  const n = t.entries.length;
  const pairs: (Entry | undefined)[] = newMid.map(() => undefined);
  const taken = new Set<Entry>();
  newMid.forEach((k, j) => {
    const i = from + j;
    let e: Entry | undefined;
    if (i < anchor.p) e = t.entries[i];
    else if (i >= kids.length - anchor.s) e = t.entries[n - (kids.length - i)];
    if (e && oldMid.includes(e) && semanticEq(k, e.node)) {
      pairs[j] = e;
      taken.add(e);
    }
  });
  let at = 0;
  newMid.forEach((k, j) => {
    const fixed = pairs[j];
    if (fixed) {
      at = oldMid.indexOf(fixed) + 1;
      return;
    }
    // the next block that is paired by its place bounds the search
    let limit = oldMid.length;
    for (let m = j + 1; m < newMid.length; m++) {
      const later = pairs[m];
      if (later) {
        limit = oldMid.indexOf(later);
        break;
      }
    }
    for (let x = at; x < limit; x++) {
      const o = oldMid[x]!;
      if (!taken.has(o) && semanticEq(k, o.node)) {
        pairs[j] = o;
        taken.add(o);
        at = x + 1;
        return;
      }
    }
  });
  return pairs;
}

/**
 * A changed block, line by line: writing the OLD block again (`before`) and the NEW one (`after`)
 * gives the same lines except where the user's edit is; those lines are the only ones taken from the
 * new text, all the others stay as the file has them (a table row padded by hand, a wrapped
 * paragraph, a hard break written with two spaces). `slice` is the old block as in the file; null
 * when its lines do not line up with `before` (then the whole block is written again).
 */
function patchLines(slice: string, before: string, after: string, prefix: string): string | null {
  const a = slice.split('\n');
  const o = before.split('\n');
  const n = after.split('\n');
  if (a.length !== o.length) return null;
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
  const middle = n.slice(p, n.length - s).map((l, i) => {
    if (p === 0 && i === 0) return l;
    return l === '' ? prefix.trimEnd() : prefix + l;
  });
  return [...a.slice(0, p), ...middle, ...a.slice(a.length - s)].join('\n');
}

/** The attributes (but the ones not written) that differ between two nodes of the same type. */
function attrDiff(a: PMNode, b: PMNode): string[] {
  const skip = NOT_WRITTEN[a.type.name] ?? [];
  return [...new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])].filter(
    (k) => !skip.includes(k) && a.attrs[k] !== b.attrs[k],
  );
}

type Kind = 'root' | 'list' | 'item' | 'quote';

function kindOf(n: PMNode): Kind {
  switch (n.type.name) {
    case 'bullet_list':
    case 'ordered_list':
      return 'list';
    case 'list_item':
      return 'item';
    default:
      return 'quote';
  }
}

export interface SerializerFor {
  schema: { topNodeType: { create(attrs: null, content: PMNode[]): PMNode } };
  serializer(settings: Record<string, unknown>): (doc: PMNode) => string;
  /** The Markdown tree of a text as the parser reads it, before any transformer (positions kept). */
  parseTree(md: string): unknown;
}

export function makeComposer(core: SerializerFor): Composer {
  const cache = new Map<string, (doc: PMNode) => string>();
  const serializerFor = (style: Style): ((doc: PMNode) => string) => {
    const key = JSON.stringify(style);
    let f = cache.get(key);
    if (!f) {
      f = core.serializer({ ...style });
      cache.set(key, f);
    }
    return f;
  };

  const fresh: Composer['fresh'] = (node, style, wrap) => {
    let inner = node;
    if (wrap && node.type.name === 'list_item') {
      // an item alone is written inside a list of its own, numbered as it is in the real one
      const attrs = { ...wrap.parent.attrs };
      if (wrap.parent.type.name === 'ordered_list') {
        attrs['order'] = ((wrap.parent.attrs['order'] as number | undefined) ?? 1) + wrap.index;
      }
      inner = wrap.parent.type.create(attrs, [node]);
    }
    const text = serializerFor(style)(core.schema.topNodeType.create(null, [inner]));
    return text.replace(/\n+$/, '');
  };

  /** What precedes a node on its line, list markers turned into spaces: the prefix of the next lines. */
  const prefixOf = (body: string, at: number, inherited: string): string => {
    const ls = body.lastIndexOf('\n', at - 1) + 1;
    const before = body.slice(ls, at);
    if (before === '') return inherited;
    return before.replace(/(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]*)?/g, (m) => ' '.repeat(m.length));
  };

  const indentLines = (text: string, prefix: string): string =>
    prefix === ''
      ? text
      : text
          .split('\n')
          .map((l, i) => (i === 0 ? l : l === '' ? prefix.trimEnd() : prefix + l))
          .join('\n');

  /** Sets the [ ] / [x] marker at the head of a list item. */
  const patchChecked = (text: string, checked: boolean | null): string => {
    const m = /^([-*+]|\d+[.)])([ \t]+)(?:\[.\][ \t]*)?/.exec(text);
    if (!m) return text;
    const marker = checked === null || checked === undefined ? '' : checked ? '[x] ' : '[ ] ';
    return m[1]! + m[2]! + marker + text.slice(m[0].length);
  };

  /**
   * A fenced block keeps its fence, its info string and every line the edit did not touch (a line
   * indented less than the fence, a closing fence with trailing text): only the lines that differ
   * are written, with the prefix of the container. `old` is the text of the block as it was loaded.
   */
  const spliceCode = (slice: string, old: string, text: string, prefix: string): string | null => {
    const lines = slice.split('\n');
    const open = /^( {0,3})(`{3,}|~{3,})/.exec(lines[0] ?? '');
    if (!open || lines.length < 2) return null;
    const close = lines[lines.length - 1]!;
    const fence = open[2]!;
    const oldLines = old === '' ? [] : old.split('\n');
    // a closing fence is the last line, unless the content already accounts for it (`    ```` is code)
    let hasClose = new RegExp(
      '^[ >]*' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$',
    ).test(close);
    if (hasClose && lines.length - 2 !== oldLines.length) hasClose = false;
    const content = lines.slice(1, hasClose ? -1 : undefined);
    if (content.length !== oldLines.length) return null;
    const newLines = text === '' ? [] : text.split('\n');
    let p = 0;
    while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
    let q = 0;
    while (
      q < oldLines.length - p &&
      q < newLines.length - p &&
      oldLines[oldLines.length - 1 - q] === newLines[newLines.length - 1 - q]
    ) {
      q++;
    }
    const added = newLines.slice(p, newLines.length - q);
    // a new line that is a closing fence ends the block there: the rest of the note would be code
    // (and what was code would be text). The block is then written again, with a longer fence.
    const closes = new RegExp(
      '^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$',
    );
    if (added.some((l) => closes.test(l))) return null;
    // Reading is not CommonMark here: it closes a fence at any line that STARTS with a long enough run
    // (`prepareSource`, a line like ```x too), and what it prepares after that point changes (a `%%`
    // comment further down is no longer blanked). A line that starts a run is not kept as the file
    // has it: the block is written again, and the serializer gives it a fence the run cannot close.
    if (added.some((l) => FENCE_RUN.test(l) || FENCE_RUN.test(prefix + l))) return null;
    const middle = added.map((l) => (l === '' ? prefix.trimEnd() : prefix + l));
    return [
      lines[0]!,
      ...content.slice(0, p),
      ...middle,
      ...content.slice(content.length - q),
      ...(hasClose ? [close] : []),
    ].join('\n');
  };

  /** The separator between two blocks of a new container, the one the file uses where it can be seen. */
  const defaultSep = (kind: Kind, prefix: string, loose: boolean): string => {
    if (kind === 'list' && !loose) return '\n';
    if (kind === 'item' && !loose) return '\n' + prefix;
    return '\n' + prefix.trimEnd() + '\n' + prefix;
  };

  const isMath = (n: PMNode): boolean => n.type.name === 'code_block' && n.attrs['form'] === 'math';

  /** A heading with a line break in it: the serializer writes it with an underline (`===`, `---`). */
  const isSetext = (n: PMNode): boolean => {
    if (n.type.name !== 'heading') return false;
    let found = false;
    n.descendants((c) => {
      if (c.type.name === 'hardbreak') found = true;
      return !found;
    });
    return found;
  };

  /** A gap (the text between two blocks) that holds a blank line (a line with nothing but the container's marks). */
  const hasBlankLine = (gap: string): boolean => /\n[ \t>]*\n/.test(gap);

  /** How many blocks beyond a window's neighbours are read with it, when no blank line stands between them. */
  const TIGHT_REACH = 4;

  /**
   * The entries `lo..hi` widened to the blocks that touch them with no blank line between: a line of
   * one of them can be read together with a line of the next (a `---` three blocks down is the
   * underline of what is above it, for the index; a lazy line is a line of the quote before it).
   */
  const tightReach = (t: BlockTable, lo: number, hi: number): [number, number] => {
    const touching = (a: number, b: number): boolean =>
      !hasBlankLine(t.body.slice(t.entries[a]!.end, t.entries[b]!.start));
    for (let c = 0; c < TIGHT_REACH && lo > 0 && touching(lo - 1, lo); c++) lo--;
    for (let c = 0; c < TIGHT_REACH && hi < t.entries.length - 1 && touching(hi, hi + 1); c++) hi++;
    return [lo, hi];
  };

  /**
   * Two blocks written one after the other with no blank line between them are read as ONE
   * thing, or as another one, unless the second one can interrupt the first: a paragraph that
   * follows a paragraph, a table, a quote or a list is a line of it; a quote that follows a
   * quote is the same quote; a rule after a paragraph makes it a heading. A heading, a rule and
   * a code block end by themselves; a heading, a fenced block and a list start by themselves.
   */
  const needsBlankLine = (prev: PMNode, next: PMNode): boolean => {
    const a = prev.type.name;
    const b = next.type.name;
    if (a === 'list_item' || b === 'list_item') return false; // the items of a list: the list's own gap
    if (a === 'heading' || a === 'hr') return false;
    // a fenced block ends by itself; a math block (`$$`) does too for the Markdown tree, but the index
    // reads it as a line of text: a rule or a `===` under it is a heading underline there
    if (a === 'code_block' && !isMath(prev)) return false;
    if (b === 'heading') return false;
    // a `---` under a paragraph makes it a heading, and a table or a quote is the same thing to the index
    if (b === 'hr') return true;
    if (b === 'code_block') return isMath(next);
    if (b === 'bullet_list') return false;
    // a list that does not start at 1 does not interrupt a paragraph; one list after another is how
    // a change of delimiter (`2.` then `3)`) is written
    if (b === 'ordered_list') {
      return ((next.attrs['order'] as number | undefined) ?? 1) !== 1 && a !== 'ordered_list';
    }
    return true;
  };

  /**
   * Where a blank line is a must, whatever the file had between the two blocks before: a list whose
   * first item starts with an empty line (`-`, `1.`) is not a list after a paragraph, a table or a
   * quote. A bare `-` under such a line is a heading underline, and an empty `1.` is text.
   */
  const blankRequired = (prev: PMNode, next: PMNode): boolean => {
    const a = prev.type.name;
    if (!['paragraph', 'table', 'blockquote', 'raw_block'].includes(a) && !isMath(prev))
      return false;
    // a heading of several lines is written as a setext one: its first line is a line of the block
    // before it (a paragraph takes it in, and the index reads a link definition as its first line)
    if (isSetext(next)) return true;
    const list = next.type.name;
    if (list !== 'bullet_list' && list !== 'ordered_list') return false;
    const first = next.firstChild;
    // (a `%%` comment is nothing to Reading: an item with only that is an empty one there)
    return (
      first !== null &&
      first.attrs['checked'] == null &&
      first.child(0).type.name === 'paragraph' &&
      (first.child(0).content.size === 0 || isComment(first.child(0)))
    );
  };

  /**
   * `gap` between two blocks, as it is, or with a blank line when what it separates now needs one.
   * `was` are the two blocks the gap stood between in the file: between blocks of the same kinds it
   * is what the file does, and it stays (a paragraph then a line of HTML, written tight, is read as it was).
   * The indentation the next block has on its line, which the gap ends with, is kept.
   */
  const fixGap = (
    gap: string,
    prev: PMNode | undefined,
    next: PMNode | undefined,
    childPrefix: string,
    was?: readonly [PMNode, PMNode],
  ): string => {
    if (!prev || !next || hasBlankLine(gap)) return gap;
    const must = blankRequired(prev, next);
    if (!must && !needsBlankLine(prev, next)) return gap;
    if (!must && was && was[0].type === prev.type && was[1].type === next.type) return gap;
    const last = gap.slice(gap.lastIndexOf('\n') + 1);
    return (
      '\n' + childPrefix.trimEnd() + '\n' + (last.startsWith(childPrefix) ? last : childPrefix)
    );
  };

  interface Run {
    t: BlockTable;
    force: boolean;
    /** Top-level blocks written again whatever the document says: what they read depends on a block that changed. */
    stale: ReadonlySet<Entry>;
  }

  const freshMemo = new WeakMap<PMNode, Map<string, string>>();
  /** `fresh` of a node of the loaded document, remembered: the same block is compared at every save. */
  const freshCached = (
    node: PMNode,
    style: Style,
    wrap: { parent: PMNode; index: number },
  ): string => {
    const key = JSON.stringify(style) + wrap.parent.type.name + wrap.index;
    let byKey = freshMemo.get(node);
    if (!byKey) freshMemo.set(node, (byKey = new Map<string, string>()));
    let text = byKey.get(key);
    if (text === undefined) byKey.set(key, (text = fresh(node, style, wrap)));
    return text;
  };

  const topRaw = (parent: PMNode, node: PMNode): boolean =>
    parent.type.name === 'doc' && node.type.name === 'raw_block';

  /** The style of the block of `e`: a list keeps its own marker (`-` then `*` are two lists, not one). */
  const styleOf = (t: BlockTable, e: Entry, style: Style): Style => {
    const name = e.node.type.name;
    if (name === 'bullet_list') {
      const ch = t.body[e.start] ?? '';
      return ch === '-' || ch === '*' || ch === '+' ? { ...style, bullet: ch } : style;
    }
    if (name === 'ordered_list') {
      const m = /^(\d+)([.)])/.exec(t.body.slice(e.start, e.start + 12));
      const second = e.children?.[1];
      const next = second
        ? /^\d+/.exec(t.body.slice(second.start, second.start + 12))?.[0]
        : undefined;
      return {
        ...style,
        bulletOrdered: m?.[2] === ')' ? ')' : '.',
        incrementListMarker: next === undefined ? style.incrementListMarker : next !== m?.[1],
      };
    }
    return style;
  };

  function composeNode(
    r: Run,
    node: PMNode,
    e: Entry,
    parent: PMNode,
    index: number,
    inherited: string,
    outer: Style,
  ): string {
    const { t, force } = r;
    const style = styleOf(t, e, outer);
    // a rule has no content to write again: the file's own form (`***`, `- - -`) stays
    if (node.type.name === 'hr' && e.node.type.name === 'hr') return t.body.slice(e.start, e.end);
    const stale = r.stale.has(e);
    if (!force && !stale && semanticEq(node, e.node)) return t.body.slice(e.start, e.end);
    const prefix = prefixOf(t.body, e.start, inherited);
    if (stale) {
      // the block is the same, but a link definition that came or went changes what its `[ref]` mean
      const written = fresh(node, style, { parent, index });
      const out = topRaw(parent, node) ? written : indentLines(written, prefix);
      return node.type.name === 'blockquote'
        ? keepEmptyQuoteLines(t.body.slice(e.start, e.end), out)
        : out;
    }
    const sameKind = node.type === e.node.type;
    if (
      !force &&
      sameKind &&
      node.type.name === 'code_block' &&
      node.attrs['language'] === e.node.attrs['language'] &&
      node.attrs['meta'] === e.node.attrs['meta'] &&
      node.attrs['form'] === e.node.attrs['form']
    ) {
      const spliced = spliceCode(
        t.body.slice(e.start, e.end),
        e.node.textContent,
        node.textContent,
        prefix,
      );
      if (spliced !== null) return spliced;
    }
    if (!force && sameKind && e.children && node.childCount > 0) {
      const diff = attrDiff(node, e.node);
      if (diff.length === 0) return composeContainer(r, node, e, prefix, style);
      // a task ticked: only the marker of the item changes
      if (node.type.name === 'list_item' && diff.length === 1 && diff[0] === 'checked') {
        return patchChecked(
          composeContainer(r, node, e, prefix, style),
          node.attrs['checked'] as boolean | null,
        );
      }
    }
    const text = fresh(node, style, { parent, index });
    const raw = topRaw(parent, node);
    const slice = t.body.slice(e.start, e.end);
    if (sameKind) {
      // the lines that writing the old block again would leave as they are keep the file's own form
      const patched = patchLines(
        slice,
        freshCached(e.node, style, { parent, index }),
        text,
        raw ? '' : prefix,
      );
      if (patched !== null) return patched;
    }
    // a raw block at the top level is the lines of the file, as they are
    const written = raw ? text : indentLines(text, prefix);
    return node.type.name === 'blockquote' ? keepEmptyQuoteLines(slice, written) : written;
  }

  /**
   * A quote that ends in empty `>` lines (`> a`, `>`) ends the quote there: what follows is a new
   * paragraph. Written again without them, the next line would continue the quote (a lazy line).
   */
  function keepEmptyQuoteLines(slice: string, written: string): string {
    const tail = /(?:\n[ \t]*>[ \t>]*)+$/.exec(slice)?.[0];
    return tail !== undefined && !written.endsWith(tail) ? written + tail : written;
  }

  /** `node` (of the kind of `e`) against its entry: the children are matched, the rest of the text is kept. */
  function composeContainer(r: Run, node: PMNode, e: Entry, prefix: string, style: Style): string {
    const { t, force } = r;
    const kids = childrenOf(node);
    const old = e.children ?? [];
    let p = 0;
    const same = (k: PMNode, o: Entry): boolean => semanticEq(k, o.node) && !r.stale.has(o);
    while (p < kids.length && p < old.length && !force && same(kids[p]!, old[p]!)) p++;
    let s = 0;
    while (
      !force &&
      s < kids.length - p &&
      s < old.length - p &&
      same(kids[kids.length - 1 - s]!, old[old.length - 1 - s]!)
    ) {
      s++;
    }
    const midNew = kids.slice(p, kids.length - s);
    const midOld = old.slice(p, old.length - s);
    const kind: Kind = e === t.root ? 'root' : kindOf(node);
    const loose = kind === 'root' || node.attrs['spread'] !== false;
    // what precedes the children on their lines: `> ` of a quote, the width of the marker of an
    // item (the block is written at the place its first child is, not at the one of the container)
    const cp =
      kind === 'root' || old.length === 0 ? prefix : prefixOf(t.body, old[0]!.start, prefix);
    // the new blocks start where the children do: the last line of the gap is the indentation of the
    // second child, which may have more of it than the others (`>     more` in an item)
    const sep = (() => {
      if (old.length <= 1) return defaultSep(kind, cp, loose);
      const gap = t.body.slice(old[0]!.end, old[1]!.start);
      return gap.slice(0, gap.lastIndexOf('\n') + 1) + cp;
    })();
    const inList = kind === 'list';
    const gapFix = (
      gap: string,
      prev: PMNode | undefined,
      next: PMNode | undefined,
      was?: readonly [PMNode, PMNode],
    ): string => (inList || gap === '' ? gap : fixGap(gap, prev, next, cp, was));

    let out = '';
    let cur = e.start;
    if (p > 0) {
      out += t.body.slice(cur, old[p - 1]!.end);
      cur = old[p - 1]!.end;
    }
    /** The new blocks written at the place of the children, and the first and the last that were written. */
    const writeNew = (
      list: PMNode[],
      from: number,
    ): { text: string; first: PMNode | undefined; last: PMNode | undefined } => {
      const written = list
        .map((k, i) => {
          const text = fresh(k, style, { parent: node, index: from + i });
          return { k, text: topRaw(node, k) ? text : indentLines(text, cp) };
        })
        .filter(({ k, text }) => !(kind === 'root' && text === '' && k.type.name === 'paragraph'));
      let text = '';
      written.forEach((w, i) => {
        text += i === 0 ? w.text : gapFix(sep, written[i - 1]!.k, w.k) + w.text;
      });
      return { text, first: written[0]?.k, last: written[written.length - 1]?.k };
    };
    /** What is left of the container after `cur`: the gap that follows the last written block is fixed. */
    const tail = (prevNode: PMNode | undefined, wasPrev?: PMNode): string => {
      const next = s > 0 ? old[old.length - s] : undefined;
      if (!next || next.start < cur) return t.body.slice(cur, e.end);
      return (
        gapFix(
          t.body.slice(cur, next.start),
          prevNode,
          kids[kids.length - s],
          wasPrev ? [wasPrev, next.node] : undefined,
        ) + t.body.slice(next.start, e.end)
      );
    };

    let lastNode: PMNode | undefined = p > 0 ? kids[p - 1] : undefined;
    if (midOld.length === midNew.length) {
      for (let i = 0; i < midOld.length; i++) {
        const o = midOld[i]!;
        out +=
          (i === 0 && p === 0
            ? t.body.slice(cur, o.start)
            : gapFix(
                t.body.slice(cur, o.start),
                lastNode,
                midNew[i],
                (i === 0 ? old[p - 1] : midOld[i - 1])
                  ? [(i === 0 ? old[p - 1]! : midOld[i - 1]!).node, o.node]
                  : undefined,
              )) + composeNode(r, midNew[i]!, o, node, p + i, cp, style);
        cur = o.end;
        lastNode = midNew[i];
      }
    } else if (midOld.length === 0) {
      // insertion between two clean blocks
      const w = writeNew(midNew, p);
      if (w.text !== '') {
        if (p > 0) {
          out += gapFix(sep, lastNode, w.first) + w.text;
          lastNode = w.last;
        } else if (old.length > 0) {
          // at the top level the indentation of the first block (`  ```) stays with it, not with the new ones
          const lead = t.body.slice(cur, old[0]!.start);
          const indent = kind === 'root' ? indentAt(t.body, old[0]!.start) : '';
          out +=
            lead.slice(0, lead.length - indent.length) +
            w.text +
            gapFix(sep, w.last, kids[kids.length - s]) +
            indent;
          cur = old[0]!.start;
          lastNode = undefined;
        } else {
          out += t.body.slice(cur, e.end) === '' ? w.text : w.text + '\n';
          cur = e.end;
          lastNode = undefined;
        }
      }
    } else if (midNew.length === 0) {
      // deletion: the blocks go with the separator that follows (or precedes) them
      const last = midOld[midOld.length - 1]!;
      if (p > 0) {
        cur = last.end;
      } else {
        const next = old[p + midOld.length];
        const lead = t.body.slice(cur, midOld[0]!.start);
        // the first block that stays keeps its own indentation (top level)
        const dropped = kind === 'root' ? indentAt(t.body, midOld[0]!.start).length : 0;
        out +=
          lead.slice(0, lead.length - dropped) +
          (kind === 'root' && next ? indentAt(t.body, next.start) : '');
        cur = next ? next.start : last.end;
        lastNode = undefined;
      }
    } else {
      const first = midOld[0]!;
      const last = midOld[midOld.length - 1]!;
      const w = writeNew(midNew, p);
      out +=
        (p > 0
          ? gapFix(t.body.slice(cur, first.start), lastNode, w.first)
          : t.body.slice(cur, first.start)) + w.text;
      cur = last.end;
      lastNode = w.last ?? lastNode;
    }
    const written =
      out +
      (midNew.length === 0 && midOld.length === 0
        ? t.body.slice(cur, e.end)
        : tail(
            lastNode,
            midOld.length === midNew.length ? midOld[midOld.length - 1]?.node : undefined,
          ));
    return kind === 'list' && !force && midOld.length !== midNew.length
      ? renumber(r, node, e, written, cp)
      : written;
  }

  /**
   * An ordered list the file numbers one by one (`1.` `2.` `3.`) keeps counting after an item came or
   * went, as Source does after Enter: the items that stayed are not left with the number of the one
   * that took their place. A list that does not count (all `1.`) or is not written that way, and an edit that would
   * give an item a number of more digits (its nested lines would no longer be under it), are left as they are.
   */
  function renumber(r: Run, node: PMNode, e: Entry, text: string, cp: string): string {
    if (node.type.name !== 'ordered_list' || e.node.type.name !== 'ordered_list') return text;
    const old = e.children ?? [];
    const nums = old.map((o) => /^(\d+)[.)]/.exec(r.t.body.slice(o.start, o.start + 12))?.[1]);
    if (old.length < 2 || nums.some((n) => n === undefined)) return text;
    const first = Number(nums[0]);
    if (!nums.every((n, i) => Number(n) === first + i)) return text;
    const start = (node.attrs['order'] as number | undefined) ?? first;
    const lines = text.split('\n');
    const hits: { line: number; len: number }[] = [];
    lines.forEach((l, i) => {
      if (i > 0 && !l.startsWith(cp)) return;
      const at = i === 0 ? 0 : cp.length;
      const m = /^(\d+)[.)](?=[ \t]|$)/.exec(l.slice(at));
      if (m) hits.push({ line: i, len: m[1]!.length });
    });
    if (hits.length !== node.childCount) return text;
    const digits = hits.map((_h, i) => String(start + i));
    if (digits.some((d, i) => d.length !== hits[i]!.len)) return text;
    hits.forEach((h, i) => {
      const l = lines[h.line]!;
      const at = h.line === 0 ? 0 : cp.length;
      lines[h.line] = l.slice(0, at) + digits[i] + l.slice(at + h.len);
    });
    return lines.join('\n');
  }

  /** A top-level block written again, as `forceDirty` does: with the style and the indentation of its place. */
  const forcedBlock = (
    t: BlockTable,
    doc: PMNode,
    kid: PMNode,
    e: Entry,
    place: Entry = e,
  ): string => {
    // a block the edit left as it is is written the same at every keystroke: the neighbours of a window are
    // (`place`: the entry whose position the block is written at, when it is not its own: a block that moved)
    if (kid !== e.node || place !== e) return forcedBlockOf(t, doc, kid, e, place);
    let text = forcedMemo.get(e);
    if (text === undefined) forcedMemo.set(e, (text = forcedBlockOf(t, doc, kid, e)));
    return text;
  };
  const forcedMemo = new WeakMap<Entry, string>();
  const forcedBlockOf = (
    t: BlockTable,
    doc: PMNode,
    kid: PMNode,
    e: Entry,
    place: Entry = e,
  ): string => {
    const slice = t.body.slice(e.start, e.end);
    // a rule has no content to write again: the file's own form (`***`, `- - -`) stays (when the entry is
    // a rule: a block moved over one is paired with the entry of its old place, which is some other block's)
    if (kid.type.name === 'hr' && e.node.type.name === 'hr') return slice;
    // a raw block that is the file's own is its lines, with what ends them (an HTML block ends at the file's end)
    if (
      kid.type.name === 'raw_block' &&
      e.node.type.name === 'raw_block' &&
      semanticEq(kid, e.node)
    ) {
      return slice;
    }
    let text = fresh(kid, styleOf(t, e, t.style));
    // the style is the block's own entry's; the indentation is the one of the place it is written at
    if (!topRaw(doc, kid)) text = indentLines(text, prefixOf(t.body, place.start, ''));
    return kid.type.name === 'blockquote' ? keepEmptyQuoteLines(slice, text) : text;
  };

  /**
   * The text of every block written again when the document has not the blocks of the file in number
   * (a block inserted or deleted): the blocks the edit did not touch each by itself, in place, and the
   * ones it changed one by one, with the markers that keep two lists apart. This is `forceDirty` for
   * such an edit; it is also what the safety net falls back to for the blocks that changed.
   */
  const forcedAll = (t: BlockTable, doc: PMNode, kids: PMNode[]): string => {
    const n = t.entries.length;
    if (n === 0) return fresh0(doc, t.style);
    let { p, s } = ends(t, kids, new Set());
    const anchor = { p, s };
    let w = rewriteWindow(t, doc, kids, p, s, '', anchor);
    // a block next to the changed ones that the written blocks would take in (two lists with the
    // same marker are one) is one of the changed ones
    while (!windowIsSound(w, w.rewritten) && (p > 0 || s > 0)) {
      p = Math.max(0, p - 1);
      s = Math.max(0, s - 1);
      w = rewriteWindow(t, doc, kids, p, s, '', anchor);
    }
    const at = (i: number, k: number, prev: number): string => {
      const e = t.entries[i]!;
      const gap = t.body.slice(i === 0 ? 0 : t.entries[i - 1]!.end, e.start);
      const lead =
        prev < 0 ? gap : fixGap(gap, kids[prev], kids[k], '', [t.entries[i - 1]!.node, e.node]);
      return lead + forcedBlock(t, doc, kids[k]!, e);
    };
    let out = p === 0 ? w.lead : '';
    for (let i = 0; i < p; i++) out += at(i, i, i - 1);
    out += w.middle;
    const shift = kids.length - n;
    for (let i = n - s; i < n; i++) {
      out +=
        i === n - s
          ? w.afterIndent + forcedBlock(t, doc, kids[i + shift]!, t.entries[i]!)
          : at(i, i + shift, i - 1 + shift);
    }
    return out + (s > 0 ? t.body.slice(t.entries[n - 1]!.end) : w.trail);
  };

  /**
   * The marker of a list or of a raw block that starts with a list item (`-`, `*`, `+`, `1.`, `2)`): two
   * lists next to each other with the same marker are ONE list. A kind apart from `.` and `)` (and
   * `-`, `*`, `+`) is what separates them.
   */
  const markerOfText = (text: string): string | undefined => {
    const b = /^ {0,3}([-*+])(?:[ \t]|$)/.exec(text);
    if (b) return 'b' + b[1]!;
    const o = /^ {0,3}\d{1,9}([.)])(?:[ \t]|$)/.exec(text);
    return o ? 'o' + o[1]! : undefined;
  };
  const markerOfEntry = (t: BlockTable, e: Entry | undefined): string | undefined => {
    if (!e) return undefined;
    const name = e.node.type.name;
    if (name !== 'bullet_list' && name !== 'ordered_list' && name !== 'raw_block') return undefined;
    return markerOfText(t.body.slice(e.start, e.start + 12));
  };
  /** A comment (`%%`) is nothing to Reading: two lists on its two sides are next to each other there. */
  const isComment = (n: PMNode): boolean => {
    if (n.type.name === 'raw_block') return /^\s*%%/.test(String(n.attrs['raw']));
    const only = n.type.name === 'paragraph' && n.childCount === 1 ? n.child(0) : null;
    return (
      only !== null && only.type.name === 'raw_inline' && /^%%/.test(String(only.attrs['raw']))
    );
  };
  /** The marker of the entry `from` steps back (-1) or forward (1) from index `i`, comments skipped. */
  const markerBeyond = (t: BlockTable, i: number, step: 1 | -1): string | undefined => {
    let j = i;
    while (t.entries[j] && isComment(t.entries[j]!.node)) j += step;
    return markerOfEntry(t, t.entries[j]);
  };

  /**
   * `style` with the marker of a list that is none of `avoid` (the markers of the lists it touches):
   * the one the file has when it can, else the first that is free. When there is none (two ordered
   * lists with a different delimiter on each side), the one that is not the previous one: the list
   * after it is then the one that is written again, and the window grows to it.
   */
  const hasTask = (list: PMNode): boolean => {
    let found = false;
    list.descendants((n) => {
      if (n.type.name === 'list_item' && n.attrs['checked'] != null) found = true;
      return !found;
    });
    return found;
  };
  const apart = (list: PMNode, style: Style, before: string | undefined, after?: string): Style => {
    const bullet = list.type.name === 'bullet_list';
    const kind = bullet ? 'b' : 'o';
    const options = bullet
      ? ([style.bullet, '-', '*', '+'] as const)
      : ([style.bulletOrdered, '.', ')'] as const);
    const taken = (m: string): boolean => before === kind + m || after === kind + m;
    // the tasks of a list with `)` are not written: the serializer would drop them
    const keep = !bullet && hasTask(list) ? [style.bulletOrdered] : options;
    const free = keep.find((m) => !taken(m)) ?? keep.find((m) => before !== kind + m);
    if (free === undefined || free === (bullet ? style.bullet : style.bulletOrdered)) return style;
    return bullet
      ? { ...style, bullet: free as Style['bullet'] }
      : { ...style, bulletOrdered: free as Style['bulletOrdered'] };
  };

  /**
   * The safety net of the edit path. The fine composition keeps what the edit did not touch, and
   * that is only right while what it keeps still means what the editor shows: Enter in a quote
   * needs the `> ` of the quote, two new paragraphs need a blank line, a fence line typed in code
   * closes the block. Each case has its own rule above, and this is what stands behind them all: the
   * blocks the edit changed, with the one before and the one after, are read again as written by
   * the fine path and as written again as a whole (the text `forceDirty` would give for them); when
   * the Markdown tree or the index entry differ (positions apart: a text written again moves them),
   * or the block before or after is not read as the same block (a fence that is not closed takes in
   * what comes after it), the changed blocks are the ones written again, with their neighbours if
   * the neighbours are what breaks, and nothing else of the note moves.
   *
   * The block before and the block after the window are kept as the file has them, and a block can
   * read differently once what is next to it changed (`- -` is an item with the text `-` after a
   * paragraph, and an item with an empty list in it after nothing). So the window is also read with
   * those two blocks written again (`strict`): when that is another text, they are rewritten too.
   *
   * Reading reads a note after `prepareSource` (comments blanked, a fence closed by any line that
   * starts a long enough run), so a window is also compared with the comments around it, and the
   * lines AFTER it as prepared for both texts (`sameReadingAfter`). A block whose rewrite would change
   * that, whatever the edit, is kept raw at loading (`unstableBlocks`): `forceDirty` then leaves it
   * as the file has it, like the edit path does.
   */
  const checked = (
    t: BlockTable,
    doc: PMNode,
    kids: PMNode[],
    fine: string,
    stale: ReadonlySet<Entry>,
  ): string => {
    let { p, s } = ends(t, kids, stale);
    const anchor = { p, s };
    // what a block reads can depend on the blocks around it (`5. a` is text after an indented code
    // block and a list without it): when the blocks changed in number or in kind, the neighbours the
    // fine path kept as they are must read as the blocks of the document, written again, do
    const structural = changedKinds(t, kids, p, s);
    for (;;) {
      const w = rewriteWindow(t, doc, kids, p, s, fine, anchor);
      if (windowIsSound(w, w.window) && sameWindow(t, w)) {
        if (!structural || (p === 0 && s === 0)) return fine;
        const wide = rewriteWindow(
          t,
          doc,
          kids,
          Math.max(0, p - 1),
          Math.max(0, s - 1),
          fine,
          anchor,
        );
        if (sameWindow(t, wide)) return fine;
        p = Math.max(0, p - 1);
        s = Math.max(0, s - 1);
        continue;
      }
      const out = t.body.slice(0, w.from) + w.rewritten + t.body.slice(w.to);
      if (
        (windowIsSound(w, w.rewritten) && strictHolds(t, w, w.rewritten)) ||
        (p === 0 && s === 0)
      ) {
        return out;
      }
      // the neighbours are what does not hold: they are written again too
      p = Math.max(0, p - 1);
      s = Math.max(0, s - 1);
    }
  };

  /** How many top-level blocks at the start (`p`) and at the end (`s`) the edit left as they were. */
  const ends = (
    t: BlockTable,
    kids: PMNode[],
    stale: ReadonlySet<Entry>,
  ): { p: number; s: number } => {
    const n = t.entries.length;
    const m = Math.min(kids.length, n);
    const same = (k: PMNode, e: Entry): boolean => semanticEq(k, e.node) && !stale.has(e);
    let p = 0;
    while (p < m && same(kids[p]!, t.entries[p]!)) p++;
    let s = 0;
    while (s < m - p && same(kids[kids.length - 1 - s]!, t.entries[n - 1 - s]!)) s++;
    return { p, s };
  };

  /** The blocks between the unchanged ones are not the same in number or in kind (or are raw text). */
  const changedKinds = (t: BlockTable, kids: PMNode[], p: number, s: number): boolean => {
    const mid = kids.slice(p, kids.length - s);
    const old = t.entries.slice(p, t.entries.length - s);
    return (
      mid.length !== old.length ||
      mid.some((k, i) => k.type !== old[i]!.node.type || k.type.name === 'raw_block')
    );
  };

  const DEFINITION = /^[ >]*\[([^\]\n]+)\]:/gm;
  const labelOf = (raw: string): string => raw.replace(/\s+/g, ' ').trim().toLowerCase();
  /** The labels of the link and footnote definitions the raw blocks of `nodes` hold. */
  const definitionsIn = (nodes: Iterable<PMNode>): Set<string> => {
    const out = new Set<string>();
    for (const node of nodes) {
      node.descendants((n) => {
        if (n.type.name === 'raw_block') {
          for (const m of String(n.attrs['raw']).matchAll(DEFINITION)) out.add(labelOf(m[1]!));
        }
        return true;
      });
      if (node.type.name === 'raw_block') {
        for (const m of String(node.attrs['raw']).matchAll(DEFINITION)) out.add(labelOf(m[1]!));
      }
    }
    return out;
  };

  /**
   * The blocks (top level) that hold `[label]` for a definition that the edit added or removed: such a
   * block, kept as the file has it, now reads as a link (or as the text it was), and the document
   * says the opposite. They are written again, with what the document has for them.
   */
  const staleBlocks = (t: BlockTable, kids: PMNode[]): Set<Entry> => {
    const { p, s } = ends(t, kids, new Set());
    const was = definitionsIn(t.entries.slice(p, t.entries.length - s).map((e) => e.node));
    const now = definitionsIn(kids.slice(p, kids.length - s));
    const changed = [...now].filter((l) => !was.has(l)).concat([...was].filter((l) => !now.has(l)));
    const out = new Set<Entry>();
    if (changed.length === 0) return out;
    const needles = changed.map((l) => `[${l}]`);
    t.entries.forEach((e, i) => {
      if (i >= p && i < t.entries.length - s) return;
      const text = labelOf(t.body.slice(e.start, e.end));
      if (needles.some((x) => text.includes(x))) out.add(e);
    });
    return out;
  };

  interface RewriteWindow {
    /** The window in the body: from the start of the line of the block before to the end of the block after. */
    from: number;
    to: number;
    before: Entry | undefined;
    after: Entry | undefined;
    /** The window as the fine path wrote it, and as the blocks written again would be. */
    window: string;
    rewritten: string;
    /** The pieces of `rewritten`: what precedes the first block, the blocks written with their gaps, the indentation of the block after, what follows the last. */
    lead: string;
    middle: string;
    afterIndent: string;
    trail: string;
    /**
     * `window` with the block before and the block after written again as `forceDirty` writes them, or
     * undefined when that is what they are already. A block kept as the file has it can read differently
     * once what is next to it changed (`- -` is an item with a text after a paragraph, and an item with
     * an empty list in it after nothing): the text of the window is then not what writing it again gives.
     */
    strict(text: string): string | undefined;
  }

  /** The blocks `p` from the start and `s` from the end are the ones the edit left as they were. */
  const rewriteWindow = (
    t: BlockTable,
    doc: PMNode,
    kids: PMNode[],
    p: number,
    s: number,
    fine: string,
    // how many blocks at each end the edit left as they were: the window may be wider than that
    anchor: { p: number; s: number } = { p, s },
  ): RewriteWindow => {
    const n = t.entries.length;
    const before = p > 0 ? t.entries[p - 1] : undefined;
    const after = s > 0 ? t.entries[n - s] : undefined;
    const oldMid = t.entries.slice(p, n - s);
    const newMid = kids.slice(p, kids.length - s);
    const from = before ? t.body.lastIndexOf('\n', before.start - 1) + 1 : 0;
    const to = after ? after.end : t.body.length;
    const window = fine.slice(from, fine.length - (t.body.length - to));
    const kidBefore = p > 0 ? kids[p - 1] : undefined;
    const kidAfter = s > 0 ? kids[kids.length - s] : undefined;

    // the same blocks written again
    let region: string;
    // (the blocks of the document that are blocks of the file, when they are written one by one)
    let pairedWith: (Entry | undefined)[] | undefined;
    if (kids.length === n) {
      // (a block that moved is written with the style of its own entry, found by identity: the nodes a move
      // carries are the ones the file's blocks were made into; the others go by place. The indentation is the
      // place's in both cases)
      region = newMid
        .map((k, i) =>
          forcedBlock(t, doc, k, oldMid.find((e) => e.node === k) ?? oldMid[i]!, oldMid[i]),
        )
        .reduce((acc, text, i) => {
          if (i === 0) return text;
          const gap = t.body.slice(oldMid[i - 1]!.end, oldMid[i]!.start);
          const was = [oldMid[i - 1]!.node, oldMid[i]!.node] as const;
          return acc + fixGap(gap, newMid[i - 1], newMid[i], '', was) + text;
        }, '');
    } else {
      // the blocks written one by one, a list with a marker that is not the one of the list next to it
      // (two lists with the same marker are one list)
      let last = markerBeyond(t, p - 1, -1);
      let lastIsNew = false;
      // a block of the document that is the same as one of the file keeps its place's indentation
      const pairs = pairBlocks(t, kids, newMid, oldMid, p, anchor);
      pairedWith = pairs;
      /** The marker a list of the document is written with, when it is one that stays as the file has it. */
      const markerOfPaired = (j: number): string | undefined => {
        const o = pairs[j];
        const k = newMid[j]!;
        if (!o || (k.type.name !== 'bullet_list' && k.type.name !== 'ordered_list'))
          return undefined;
        const st = styleOf(t, o, t.style);
        return k.type.name === 'bullet_list' ? 'b' + st.bullet : 'o' + st.bulletOrdered;
      };
      const pieces = newMid.map((k, i) => {
        const o = pairs[i];
        // a block the edit did not touch is written as `forceDirty` writes it: with its own style
        let st = o ? styleOf(t, o, t.style) : t.style;
        const isList = k.type.name === 'bullet_list' || k.type.name === 'ordered_list';
        if (isList) {
          // the marker of what comes next when it is fixed: the block that stays, or a raw block
          let j = i + 1;
          while (newMid[j] && isComment(newMid[j]!)) j++;
          const following = newMid[j];
          const next = following
            ? following.type.name === 'raw_block'
              ? markerOfText(String(following.attrs['raw']))
              : markerOfPaired(j)
            : kidAfter && after
              ? markerBeyond(t, n - s, 1)
              : undefined;
          // A list that is the file's own keeps its marker, unless the list before it is new and has
          // taken it (that is what the edit did); the new ones move away from the lists around them.
          // Two lists of the file that Reading already sees as one (a comment between them) stay so.
          if (!o) st = apart(k, st, last, next);
          else if (lastIsNew) st = apart(k, st, last);
          last = k.type.name === 'bullet_list' ? 'b' + st.bullet : 'o' + st.bulletOrdered;
          lastIsNew = !o;
        } else if (!isComment(k)) {
          last = k.type.name === 'raw_block' ? markerOfText(String(k.attrs['raw'])) : undefined;
          lastIsNew = !o;
        }
        if (!o) return fresh(k, st);
        // a block that is the file's own, but a list (its marker is chosen above), is written as `forceDirty`
        // writes it: a raw block as its lines (an unclosed fence ends with the blank lines of the file), a
        // quote with the empty `>` lines that end it
        if (!isList) return indentAt(t.body, o.start) + forcedBlock(t, doc, k, o);
        const text = fresh(k, st);
        const own = topRaw(doc, k) ? text : indentLines(text, prefixOf(t.body, o.start, ''));
        return indentAt(t.body, o.start) + own;
      });
      // two blocks of the file that are still next to each other keep the gap the file has between them
      // (a comment and the table that follows it tight), the others are apart by a blank line
      region = pieces.reduce((acc, text, i) => {
        if (i === 0) return text;
        const a = pairs[i - 1];
        const b = pairs[i];
        const at = a ? oldMid.indexOf(a) : -1;
        if (a && b && oldMid[at + 1] === b) {
          const gap = t.body.slice(a.end, b.start);
          const bare = gap.slice(0, gap.length - indentAt(t.body, b.start).length);
          return acc + fixGap(bare, newMid[i - 1], newMid[i], '', [a.node, b.node]) + text;
        }
        return acc + '\n\n' + text;
      }, '');
    }
    const firstOld = oldMid[0];
    const lastOld = oldMid[oldMid.length - 1];
    // the gaps of the file around the blocks; where the blocks touch (an insertion at the very start) a blank line
    // (blocks that touch: the first of them ends with its own line end when it is a raw block that
    // takes it in, an unclosed fence; else there is no line end between them and a blank line is put)
    const gapBetween = (from: number, to: number): string =>
      t.body.slice(from, to) || (from > 0 && t.body[from - 1] === '\n' ? '' : '\n\n');
    let gapBefore = before
      ? gapBetween(before.end, (firstOld ?? after)?.start ?? t.body.length)
      : '';
    // blocks added after the last one: what follows it in the file is the end of the file (its line
    // end), not a gap between two blocks, and the new ones are apart from it by a blank line
    if (before && !firstOld && !after && newMid.length > 0 && !hasBlankLine(gapBefore)) {
      gapBefore = '\n\n';
    }
    const gapAfter = after
      ? lastOld || before
        ? gapBetween(lastOld?.end ?? before?.end ?? 0, after.start)
        : '\n\n'
      : '';
    const head = firstOld ?? after;
    let lead = before ? '' : t.body.slice(0, head?.start ?? t.body.length);
    // a block that stays at the start of the note keeps its own indentation, wherever the new ones go
    let afterIndent = '';
    if (!before && head) {
      // a block that stays at the start keeps its own indentation, wherever the new ones go; the blocks
      // written one by one (not as many as the file's) bring their own
      const insertion = newMid.length === 0 || !firstOld;
      if (insertion || kids.length !== n) {
        lead = lead.slice(0, lead.length - indentAt(t.body, head.start).length);
      }
      if (insertion) afterIndent = after ? indentAt(t.body, after.start) : '';
    }
    const trail = after ? '' : t.body.slice(lastOld?.end ?? before?.end ?? 0);
    // (the blocks written one by one bring the indentation of their own place, not the next block's)
    const gapB =
      kids.length !== n && newMid.length > 0 ? gapBefore.replace(/[ \t]+$/, '') : gapBefore;
    const regionText =
      newMid.length === 0
        ? // blocks deleted: the gap that ends with what follows them (the indentation of `after` is in it)
          fixGap(before && after ? gapAfter : gapBefore, kidBefore, kidAfter, '')
        : fixGap(
            gapB,
            kidBefore,
            newMid[0],
            '',
            // (the gap of the file between two blocks is the one of two blocks that are still those)
            before && firstOld && (!pairedWith || pairedWith[0] === firstOld)
              ? [before.node, firstOld.node]
              : undefined,
          ) +
          region +
          fixGap(
            gapAfter,
            newMid[newMid.length - 1],
            kidAfter,
            '',
            lastOld && after && (!pairedWith || pairedWith[pairedWith.length - 1] === lastOld)
              ? [lastOld.node, after.node]
              : undefined,
          );
    const middle = before && newMid.length === 0 && !after ? '' : regionText;
    const rewritten =
      lead +
      (before ? t.body.slice(from, before.end) : '') +
      middle +
      (after ? afterIndent + t.body.slice(after.start, after.end) : '') +
      trail;
    const strict = (text: string): string | undefined => {
      const head = before && kidBefore ? forcedBlock(t, doc, kidBefore, before) : undefined;
      const foot = after && kidAfter ? forcedBlock(t, doc, kidAfter, after) : undefined;
      const headLen = before ? before.end - from : 0;
      const footLen = after ? after.end - after.start : 0;
      const keptHead = before ? t.body.slice(before.start, before.end) : '';
      const keptFoot = after ? t.body.slice(after.start, after.end) : '';
      if ((head ?? keptHead) === keptHead && (foot ?? keptFoot) === keptFoot) return undefined;
      const lineStart = before ? before.start - from : 0;
      return (
        text.slice(0, lineStart) +
        (head ?? keptHead) +
        text.slice(headLen, text.length - footLen) +
        (foot ?? keptFoot)
      );
    };
    return { from, to, before, after, window, rewritten, lead, middle, afterIndent, trail, strict };
  };

  /**
   * Two texts of a window mean the same: the same Markdown tree and the same index entry (positions
   * apart) and, for what Reading prepares line by line before it reads the Markdown (the `%%`
   * comments, which it does not see inside an item), the same tree after that preparation.
   */
  const sameMeaning = (a: string, b: string): boolean =>
    a === b ||
    (treeOf(core, a) === treeOf(core, b) &&
      shapeOf(a) === shapeOf(b) &&
      (!(READING_LINES.test(a) || READING_LINES.test(b)) ||
        treeOf(core, prepareSource(a)) === treeOf(core, prepareSource(b))));

  /**
   * What Reading prepares for the lines AFTER a piece of the note (`prepareSource` carries the state of
   * a fence and of a comment from line to line): the same for the two texts of the piece. It is what
   * a fence run typed in a code block, or a `%%` left open, changes a few blocks further down.
   */
  const sameReadingAfter = (
    body: string,
    from: number,
    to: number,
    a: string,
    b: string,
  ): boolean => {
    if (a === b) return true;
    const rest = body.slice(to);
    if (!READING_LINES.test(rest) && !READING_LINES.test(a) && !READING_LINES.test(b)) return true;
    const lines = rest.split('\n').length - 1;
    if (lines === 0) return true;
    const head = body.slice(0, from);
    const tail = (text: string): string =>
      prepareSource(head + text + rest)
        .split('\n')
        .slice(-lines)
        .join('\n');
    return tail(a) === tail(b);
  };

  /** The window as the fine path wrote it means what the blocks written again mean (and so does what follows it). */
  const sameWindow = (t: BlockTable, w: RewriteWindow): boolean => {
    if (!sameReadingAfter(t.body, w.from, w.to, w.window, w.rewritten)) return false;
    // the block before and the block after, as the file has them, read as they would written again
    if (!strictHolds(t, w, w.window)) return false;
    if (w.window === w.rewritten) return true;
    return sameMeaningAround(t, w, w.window, w.rewritten);
  };

  /** `text` of the window means what it does with the block before and the block after written again. */
  const strictHolds = (t: BlockTable, w: RewriteWindow, text: string): boolean => {
    const strict = w.strict(text);
    return strict === undefined || sameMeaningAround(t, w, text, strict);
  };

  /** Two texts of the window mean the same, each read with what the note has around the window. */
  const sameMeaningAround = (t: BlockTable, w: RewriteWindow, a: string, b: string): boolean => {
    // Reading sees a comment as nothing: a list on the other side of the comments that border the
    // window is next to the window's blocks there, and the window is read with it
    const last = t.entries.length - 1;
    let lo = w.before ? t.entries.indexOf(w.before) : -1;
    let hi = w.after ? t.entries.indexOf(w.after) : -1;
    while (lo > 0 && isComment(t.entries[lo]!.node)) lo--;
    while (hi >= 0 && hi < last && isComment(t.entries[hi]!.node)) hi++;
    // and so are the blocks that touch the window a little further: with no blank line between, a
    // line of one is read with a line of the next
    const [lo2, hi2] = tightReach(t, Math.max(lo, 0), hi >= 0 ? hi : last);
    if (lo >= 0) lo = lo2;
    if (hi >= 0) hi = hi2;
    const from = lo >= 0 ? t.body.lastIndexOf('\n', t.entries[lo]!.start - 1) + 1 : w.from;
    const to = hi >= 0 ? t.entries[hi]!.end : w.to;
    const around = (text: string): string =>
      t.body.slice(from, w.from) + text + t.body.slice(w.to, to);
    return sameMeaning(around(a), around(b));
  };

  /** A block of the Markdown tree can be what the document has there (a table is not a paragraph). */
  const kindMatches = (md: { type: string } | undefined, node: PMNode): boolean => {
    if (!md || node.type.name === 'raw_block') return true;
    const kinds = KINDS[md.type];
    // (a `math` block, a line of HTML and a definition are not in the table: raw or code blocks)
    return kinds === undefined || kinds.includes(node.type.name);
  };

  /** The block before and the block after are read as the very same blocks: where they were, and as long. */
  const windowIsSound = (w: RewriteWindow, text: string): boolean => {
    if (!w.before && !w.after) return true;
    let tree: {
      children?: {
        type: string;
        position?: { start: { offset: number }; end: { offset: number } };
      }[];
    };
    try {
      tree = core.parseTree(text) as typeof tree;
    } catch {
      return false;
    }
    const kids = tree.children ?? [];
    if (w.before) {
      const first = kids[0]?.position;
      if (first?.start.offset !== w.before.start - w.from) return false;
      if (first.end.offset !== w.before.end - w.from) return false;
      if (!kindMatches(kids[0], w.before.node)) return false;
    }
    if (w.after) {
      const last = kids[kids.length - 1]?.position;
      if (last?.end.offset !== text.length) return false;
      if (last.start.offset !== text.length - (w.after.end - w.after.start)) return false;
      if (!kindMatches(kids[kids.length - 1], w.after.node)) return false;
    }
    return true;
  };

  return {
    fresh,
    unstableBlocks(t) {
      const out = new Set<number>();
      t.entries.forEach((e, i) => {
        if (e.node.type.name === 'raw_block' || e.node.type.name === 'hr') return;
        const was = t.body.slice(e.start, e.end);
        // the block as `forceDirty` writes it, indentation of its place included
        const text = forcedBlock(t, t.doc, e.node, e);
        if (text === was) return;
        // the block between its neighbours, from the start of the line: the indentation of a block,
        // and what comes right after it (`    code` after a list), are part of how it is read
        const [lo, hi] = tightReach(t, Math.max(i - 1, 0), Math.min(i + 1, t.entries.length - 1));
        const from = t.body.lastIndexOf('\n', t.entries[lo]!.start - 1) + 1;
        const to = t.entries[hi]!.end;
        const before = t.body.slice(from, to);
        const after = t.body.slice(from, e.start) + text + t.body.slice(e.end, to);
        if (!sameMeaning(before, after) || !sameReadingAfter(t.body, from, to, before, after)) {
          out.add(e.start);
          return;
        }
        // What Reading prepares is read in a context that reaches further than the next block (a
        // quote or a list two blocks back decides whether a line is a lazy line or an item): the
        // same check with two blocks on each side
        const from2 =
          t.body.lastIndexOf('\n', (t.entries[i - 2] ?? t.entries[i - 1] ?? e).start - 1) + 1;
        const to2 = (t.entries[i + 2] ?? t.entries[i + 1] ?? e).end;
        const before2 = t.body.slice(from2, to2);
        const after2 = t.body.slice(from2, e.start) + text + t.body.slice(e.end, to2);
        if (
          (READING_LINES.test(before2) || READING_LINES.test(after2)) &&
          treeOf(core, prepareSource(before2)) !== treeOf(core, prepareSource(after2))
        ) {
          out.add(e.start);
        }
      });
      return out;
    },
    compose(t, doc, opts = {}) {
      const force = opts.forceDirty ?? false;
      if (!force && semanticEq(doc, t.doc)) return t.body;
      const kids = childrenOf(doc);
      if (kids.length === 1 && kids[0]!.type.name === 'paragraph' && kids[0]!.content.size === 0) {
        return '';
      }
      if (force) {
        // every top-level block is written again; the gaps between them (and what the table kept) stay
        if (kids.length !== t.entries.length) return forcedAll(t, doc, kids);
        // (a gap that a block written again can no longer have, as `# H` + `next` once `H` is a paragraph, gets its blank line)
        let out = '';
        let cur = 0;
        for (let i = 0; i < kids.length; i++) {
          const e = t.entries[i]!;
          const gap = t.body.slice(cur, e.start);
          const prev = t.entries[i - 1];
          out +=
            (prev ? fixGap(gap, kids[i - 1], kids[i], '', [prev.node, e.node]) : gap) +
            forcedBlock(t, doc, kids[i]!, e);
          cur = e.end;
        }
        return out + t.body.slice(cur);
      }
      const stale = staleBlocks(t, kids);
      return checked(
        t,
        doc,
        kids,
        composeContainer({ t, force, stale }, doc, t.root, '', t.style),
        stale,
      );
    },
  };

  function fresh0(doc: PMNode, style: Style): string {
    return serializerFor(style)(doc);
  }
}

/** The blanks that are all there is before `pos` on its line (the indentation of a block), or ''. */
function indentAt(body: string, pos: number): string {
  const seg = body.slice(body.lastIndexOf('\n', pos - 1) + 1, pos);
  return /^[ \t]*$/.test(seg) ? seg : '';
}

/** What Reading changes in the text before it reads it: comments and escaped `[[`, `^[`. */
export const READING_LINES = /%%|\\\[\[|\\\^\[/;

/** A line Reading takes for a fence (to open one or to close one): `prepareSource` has the same pattern. */
const FENCE_RUN = /^ {0,3}(?:`{3,}|~{3,})/;

const POSITIONS = new Set(['line', 'start', 'end', 'targetStart', 'targetEnd', 'frontmatterLines']);

/** The Markdown tree of a piece of text, positions apart: what Reading builds its HTML from. */
function treeOf(core: SerializerFor, md: string): string {
  try {
    return JSON.stringify(core.parseTree(md), (k, v: unknown) =>
      k === 'position' ? undefined : v,
    );
  } catch {
    // the parser of a development build asserts on a few corners: a text it cannot read is not any tree
    return 'THROWS';
  }
}

/** What the index would store for a piece of Markdown, positions apart. */
function shapeOf(md: string): string {
  return JSON.stringify(extract('t', md), (k, v: unknown) => (POSITIONS.has(k) ? undefined : v));
}
