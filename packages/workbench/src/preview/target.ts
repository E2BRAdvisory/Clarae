// Locating the wikilink under a position of a line of text (editor hover, "Preview
// link under cursor"). Embeds (![[…]]) are not previewed: they already show their content.
import { parseWikilinkInner } from '@memobrain/markdown';
import type { LinkSpec } from '../editor/types';

export interface LinkAt {
  /** Offsets of "[[…]]" within the line. */
  from: number;
  to: number;
  spec: LinkSpec;
}

const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;

/** The wikilink whose "[[…]]" covers column `col` (0-based) of `line`, if any. */
export function wikilinkAt(line: string, col: number): LinkAt | null {
  for (const m of line.matchAll(WIKILINK)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (col < from || col > to) continue;
    if (m[1]) return null; // an embed
    if (from > 0 && line[from - 1] === '\\') return null; // escaped
    const p = parseWikilinkInner(m[2] ?? '');
    if (!p.target && !p.heading && !p.block) return null;
    return {
      from,
      to,
      spec: { target: p.target, heading: p.heading, block: p.block, alias: p.alias, embed: false },
    };
  }
  return null;
}

/** A stable key for a link as seen from a note, to tell "same link" from "another link". */
export const linkKey = (from: string, s: Pick<LinkSpec, 'target' | 'heading' | 'block'>): string =>
  `${from}\u0000${s.target}\u0000${s.heading}\u0000${s.block}`;
