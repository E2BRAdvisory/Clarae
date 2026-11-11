// Where the OFM constructs of a note body are, line by line: THE definition of "what the index sees".
//
// The indexer (extract.ts) reads its links, tags, block ids, footnotes and tasks from here, and any
// other consumer that must agree with the index (the Live editor's Markdown layer) reads the same
// spans, so a construct is never a link on one side and plain text on the other.
//
// Block structure (which lines are code) comes from the Markdown tree and from the fence lines, as in
// the Go parser; the spans of every other line come from scanInline, carrying the %%comment%% and
// $$math$$ state from line to line.
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Code, Root } from 'mdast';
import { scanInline, type BlockState, type InlineSpan } from './inline';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface BodyScan {
  /** The body split on "\n" (a CR before it, if any, stays on the line). */
  lines: string[];
  /** Offset of the first character of each line in the body. */
  starts: number[];
  /** True for the lines of fenced and indented code, delimiters included: they are not scanned. */
  code: boolean[];
  /** Per line, the spans of scanInline (offsets relative to the line); empty for code lines. */
  spans: InlineSpan[][];
  /** The CommonMark tree the code lines were taken from (no GFM: the index does not use it). */
  tree: Root;
}

/** Marks the lines of code in `lines` (mdast code nodes plus fence delimiters). */
function codeLines(lines: string[], tree: Root): boolean[] {
  const code = new Array<boolean>(lines.length).fill(false);
  const visit = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'code') {
      const c = node as Code;
      const s = c.position?.start.line ?? 0;
      const e = c.position?.end.line ?? 0;
      for (let l = s; l <= e; l++) if (l >= 1 && l <= code.length) code[l - 1] = true;
    }
    for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[])
      visit(child);
  };
  visit(tree);

  // Fence delimiters (also handles fences goldmark-style at any nesting we saw in the Go port).
  let inFence = false;
  let fence = '';
  lines.forEach((l, i) => {
    const m = FENCE.exec(l);
    if (!m) return;
    const delim = m[1] ?? '';
    if (!inFence) {
      inFence = true;
      fence = delim;
      code[i] = true;
    } else if (delim.startsWith(fence.charAt(0)) && delim.length >= fence.length) {
      inFence = false;
      code[i] = true;
    }
  });
  return code;
}

/** The lines of a body, which of them are code, and the OFM spans of the others. */
export function scanBody(body: string): BodyScan {
  const lines = body.split('\n');
  const tree: Root = fromMarkdown(body);
  const code = codeLines(lines, tree);
  const state: BlockState = { inMath: false, inComment: false };
  const starts: number[] = [];
  const spans: InlineSpan[][] = [];
  let at = 0;
  lines.forEach((raw, i) => {
    starts.push(at);
    at += raw.length + 1;
    spans.push(code[i] ? [] : scanInline(raw, state));
  });
  return { lines, starts, code, spans, tree };
}
