// The block table (A-D3): which source text each block of the loaded document comes from.
//
// It is built on the document AFTER loading (the plugins that adjust the document when it is shown, as
// the one of the heading ids, have run: a table built before would see every such heading as changed),
// from the mdast positions of the very pipeline that parsed the file, down to the second level: the
// items of a list, the children of an item, the children of a blockquote or a callout.
//
// The table is only an alignment: every mdast child must have one document child of a compatible
// kind. If that does not hold anywhere, there is no table, and the note does not open in Live.
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { inferStyle, type Style } from './style';

export interface Entry {
  node: PMNode;
  /** Offsets in the body (LF) of the source text of this block, without the line ends around it. */
  start: number;
  end: number;
  children?: Entry[];
}

export interface BlockTable {
  /** The Markdown body (LF) the table was built on. */
  body: string;
  /** The loaded document. */
  doc: PMNode;
  entries: Entry[];
  /** The whole body as the entry of the root, for the composition. */
  root: Entry;
  style: Style;
}

interface MdNode {
  type: string;
  children?: MdNode[] | undefined;
  position?: { start: { offset: number }; end: { offset: number } } | undefined;
}

/** The document node types an mdast type may become. */
export const KINDS: Record<string, readonly string[]> = {
  paragraph: ['paragraph'],
  'image-block': ['image-block'],
  heading: ['heading'],
  code: ['code_block'],
  thematicBreak: ['hr'],
  blockquote: ['blockquote'],
  list: ['bullet_list', 'ordered_list'],
  listItem: ['list_item'],
  table: ['table'],
  ofmRawBlock: ['raw_block'],
};

const CONTAINERS = new Set(['list', 'listItem', 'blockquote']);

export function childrenOf(n: PMNode): PMNode[] {
  const out: PMNode[] = [];
  n.forEach((c) => out.push(c));
  return out;
}

function align(pm: PMNode[], md: MdNode[]): Entry[] | null {
  if (pm.length !== md.length) return null;
  const out: Entry[] = [];
  let at = 0;
  for (let i = 0; i < pm.length; i++) {
    const m = md[i]!;
    const n = pm[i]!;
    const p = m.position;
    if (!p || !KINDS[m.type]?.includes(n.type.name)) return null;
    // blocks are in order and do not overlap (some corners of CommonMark give overlapping positions)
    if (p.start.offset < at || p.end.offset < p.start.offset) return null;
    at = p.end.offset;
    const e: Entry = { node: n, start: p.start.offset, end: p.end.offset };
    // an empty item or quote (`-`, `>`) has one empty paragraph in the document: it is a leaf here
    if (CONTAINERS.has(m.type) && (m.children ?? []).length > 0) {
      const kids = align(childrenOf(n), m.children ?? []);
      if (!kids) return null;
      e.children = kids;
    }
    out.push(e);
  }
  return out;
}

/** The table of `doc`, the loaded document of `body`; null when the two do not line up. */
export function buildTable(body: string, doc: PMNode, mdastRoot: object): BlockTable | null {
  const mdast = mdastRoot as MdNode;
  const md = mdast.children ?? [];
  const kids = childrenOf(doc);
  // an empty file is a document with one empty paragraph
  const empty = md.length === 0 && kids.length === 1 && kids[0]!.content.size === 0;
  const entries = empty ? [] : align(kids, md);
  if (!entries) return null;
  const root: Entry = { node: doc, start: 0, end: body.length, children: entries };
  return { body, doc, entries, root, style: inferStyle(body, mdast) };
}
