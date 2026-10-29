// Finding what is under the cursor: the heading a line belongs to and the block
// (paragraph or list item) with its ^id, for "bookmark current heading/block".
import { extract } from '@memobrain/markdown';

/** The nearest heading at or above the 1-based line, or null. */
export function headingAtLine(text: string, line: number): { text: string; level: number } | null {
  let found: { text: string; level: number } | null = null;
  for (const h of extract('', text).headings) {
    if (h.line > line) break;
    found = { text: h.text, level: h.level };
  }
  return found;
}

const BLOCK_ID = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)]|>)/;
const isBoundary = (l: string): boolean => l.trim() === '' || /^#{1,6}(\s|$)/.test(l);

export interface BlockAt {
  /** The block's ^id, or null when it has none yet. */
  id: string | null;
  /** 1-based line where an id is (or would be) written: the last line of the block. */
  endLine: number;
}

/** The block containing the 1-based line; null on blank lines and headings. */
export function blockAtLine(text: string, line: number): BlockAt | null {
  const lines = text.split('\n');
  const at = line - 1;
  if (at < 0 || at >= lines.length || isBoundary(lines[at] ?? '')) return null;
  let to = at;
  if (!ITEM.test(lines[at] ?? '')) {
    while (
      to + 1 < lines.length &&
      !isBoundary(lines[to + 1] ?? '') &&
      !ITEM.test(lines[to + 1] ?? '')
    )
      to++;
  }
  const m = BLOCK_ID.exec(lines[to] ?? '');
  return { id: m ? (m[1] ?? null) : null, endLine: to + 1 };
}

/** A short random block id such as "k3f9x2". */
export function newBlockId(rand: () => number = Math.random): string {
  let id = '';
  while (id.length < 6) id += Math.floor(rand() * 36).toString(36);
  return id;
}
