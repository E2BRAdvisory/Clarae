// The size beyond which a note opens in Source (A-D10): ProseMirror does not virtualize its DOM, so the
// document of a very large note, a block of it or the number of code blocks (each one is an editor of
// its own) is paid for in memory and in the time to open. Measured on the real editor mounted in jsdom
// (A-W4; a browser is faster at the DOM, the figures keep the proportions), a note of prose and lists:
//
//    blocks    chars    DOM nodes   open      a text() after an edit
//      400     29 kB      1 200     0.19 s    3 ms
//    3 000     99 kB     30 000     1.2 s     4 ms
//    6 000    198 kB     60 000     2.8 s     5 ms
//   12 000    405 kB    120 000     7.6 s     10 ms
//
// and a table, whose rows are one block that is written whole when it is edited (what `text()` and the
// position of the cursor ask for after a pause in typing): 500 rows (11 kB) 110 ms, 2 000 rows (49 kB)
// 580 ms. The spike measured a note of 146 kB opening in 300 ms. The limits keep the opening near a
// second and a block that is edited under a quarter of one; the code blocks draw their editor when they
// are seen, so their number matters less than their size.
//
// This module is tiny and has no dependency: it can be asked, before any editor chunk is fetched,
// whether Live is worth opening.

export interface LiveMax {
  /** Characters of the whole file. */
  chars: number;
  /** Blocks: paragraphs, headings, list items, quotes, code blocks, tables, rules. */
  blocks: number;
  /** Characters of the longest block (a table of thousands of rows, a code block of a whole file). */
  block: number;
  /** Code blocks: each has an editor of its own. */
  codeBlocks: number;
}

export const LIVE_MAX: LiveMax = {
  chars: 250_000,
  blocks: 3_000,
  block: 20_000,
  codeBlocks: 150,
};

export type LimitReason = 'chars' | 'blocks' | 'block' | 'codeBlocks';

export interface Limit {
  reason: LimitReason;
  /** What the note has, and what the limit is. */
  value: number;
  max: number;
}

export interface Measure {
  chars: number;
  blocks: number;
  block: number;
  codeBlocks: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM = /^ *(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** The figures of a text that the limits are about, in one pass; a block is a run of lines between blank lines. */
export function measure(raw: string): Measure {
  let blocks = 0;
  let codeBlocks = 0;
  let longest = 0;
  let run = 0;
  let fence = '';
  let open = false;
  let pos = 0;
  while (pos <= raw.length) {
    let end = raw.indexOf('\n', pos);
    if (end < 0) end = raw.length;
    const line = raw.slice(pos, end);
    const blank = fence === '' && line.trim() === '';
    if (blank) {
      open = false;
      longest = Math.max(longest, run - 1);
      run = 0;
    } else {
      if (!open) {
        blocks++;
        open = true;
      } else if (fence === '' && ITEM.test(line)) blocks++;
      run += line.length + 1;
      const f = FENCE.exec(line);
      if (fence === '' && f) {
        fence = f[1] as string;
        codeBlocks++;
      } else if (
        fence !== '' &&
        f &&
        f[1]!.startsWith(fence[0] as string) &&
        f[1]!.length >= fence.length
      ) {
        fence = '';
      }
    }
    pos = end + 1;
  }
  longest = Math.max(longest, run - 1);
  return { chars: raw.length, blocks, block: longest, codeBlocks };
}

/** The first limit a text goes over, or null when Live can open it. */
export function liveLimit(raw: string, max: LiveMax = LIVE_MAX): Limit | null {
  // the cheapest check first: a note over the limit of characters is not even measured
  if (raw.length > max.chars) return { reason: 'chars', value: raw.length, max: max.chars };
  const m = measure(raw);
  if (m.blocks > max.blocks) return { reason: 'blocks', value: m.blocks, max: max.blocks };
  if (m.block > max.block) return { reason: 'block', value: m.block, max: max.block };
  if (m.codeBlocks > max.codeBlocks)
    return { reason: 'codeBlocks', value: m.codeBlocks, max: max.codeBlocks };
  return null;
}
