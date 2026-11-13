import { StateField, type EditorState, type Text, type Transaction } from '@codemirror/state';
import { scanSpans, stripInlineCode, type BlockState } from '@clarae/markdown';

/** Block state (inside %%comment%% / $$math$$) at the START of each line. */
export interface LineBlockState {
  inMath: boolean;
  inComment: boolean;
}

export interface DocBlockStates {
  /** Index = line number - 1. */
  lines: LineBlockState[];
  /** Number of lines taken by the frontmatter block (0 = none). */
  frontmatterLines: number;
  /** The first line opens a frontmatter that nothing closes (yet). */
  frontmatterOpen: boolean;
}

/**
 * The frontmatter of a document, line by line: the same answer as splitFrontmatter on its text,
 * without building the text of the whole document. `open`: the first line is `---` but no line
 * closes it, so any later line may still do.
 */
export function frontmatterOf(doc: Text): { lines: number; open: boolean } {
  const strip = (t: string): string => t.replace(/\r+$/, '');
  // a mark at the start of the file is not content (one, as in `splitFrontmatter` and in the indexer)
  const first = doc.lines > 0 ? doc.line(1).text.replace(/^\uFEFF/, '') : '';
  if (doc.lines < 2 || strip(first) !== '---') return { lines: 0, open: false };
  for (let n = 2; n <= doc.lines; n++) {
    const t = strip(doc.line(n).text);
    if (t === '---' || t === '...') return { lines: n, open: false };
  }
  return { lines: 0, open: true };
}

/** A line that would close a frontmatter. */
export const FRONTMATTER_END = /^(---|\.\.\.)\r*$/m;

/** The span of all the changes of a transaction, in the old and in the new document. */
export function changedSpan(tr: Transaction): {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
} {
  let fromA = Infinity;
  let toA = -1;
  let fromB = Infinity;
  let toB = -1;
  tr.changes.iterChangedRanges((fa, ta, fb, tb) => {
    fromA = Math.min(fromA, fa);
    toA = Math.max(toA, ta);
    fromB = Math.min(fromB, fb);
    toB = Math.max(toB, tb);
  });
  return { fromA, toA, fromB, toB };
}

/** The state at the start of every line from line `from` (whose start state is `st`) on. */
function scanFrom(
  doc: Text,
  from: number,
  fmLines: number,
  start: BlockState,
  lines: LineBlockState[],
  stop?: (n: number, st: BlockState) => boolean,
): number {
  const st: BlockState = { inMath: start.inMath, inComment: start.inComment };
  for (let i = from; i <= doc.lines; i++) {
    if (stop?.(i, st)) return i;
    lines.push({ inMath: st.inMath, inComment: st.inComment });
    if (i <= fmLines) continue;
    const line = doc.line(i).text;
    if (line.includes('%%') || line.includes('$$') || st.inMath || st.inComment) {
      scanSpans(stripInlineCode(line), st);
    }
  }
  return doc.lines + 1;
}

function compute(doc: Text): DocBlockStates {
  const fm = frontmatterOf(doc);
  const lines: LineBlockState[] = [];
  scanFrom(doc, 1, fm.lines, { inMath: false, inComment: false }, lines);
  return { lines, frontmatterLines: fm.lines, frontmatterOpen: fm.open };
}

/**
 * The states after a change: the lines before it keep theirs, the following ones are scanned until
 * a line after the change starts in the state it had before, from where the old states still hold.
 * Typing in a long note costs a few lines instead of the whole document.
 */
function update(prev: DocBlockStates, tr: Transaction): DocBlockStates {
  const oldDoc = tr.startState.doc;
  const doc = tr.newDoc;
  const { fromA, fromB, toB } = changedSpan(tr);
  const first = oldDoc.lineAt(fromA).number;
  const lastNew = doc.lineAt(toB).number;
  if (first === 1 || first <= prev.frontmatterLines) return compute(doc);
  if (
    prev.frontmatterOpen &&
    FRONTMATTER_END.test(doc.sliceString(doc.lineAt(fromB).from, doc.line(lastNew).to))
  )
    return compute(doc);
  const lineDelta = doc.lines - oldDoc.lines;
  const lines = prev.lines.slice(0, first - 1);
  const start = prev.lines[first - 1] ?? { inMath: false, inComment: false };
  const at = scanFrom(doc, first, prev.frontmatterLines, start, lines, (n, st) => {
    if (n <= lastNew) return false;
    const old = prev.lines[n - lineDelta - 1];
    return old !== undefined && old.inMath === st.inMath && old.inComment === st.inComment;
  });
  if (at <= doc.lines)
    for (let j = at - lineDelta - 1; j < prev.lines.length; j++)
      lines.push(prev.lines[j] as LineBlockState);
  return {
    lines,
    frontmatterLines: prev.frontmatterLines,
    frontmatterOpen: prev.frontmatterOpen,
  };
}

/**
 * Per-line comment/math state, recomputed when the document changes. Code
 * fences are not considered here; callers skip fenced lines themselves, which
 * matches the indexer (it skips code lines before scanning).
 */
export const blockStates = StateField.define<DocBlockStates>({
  create: (state) => compute(state.doc),
  update: (value, tr) => (tr.docChanged ? update(value, tr) : value),
});

export function blockStateAt(state: EditorState, lineNumber: number): BlockState {
  const s = state.field(blockStates).lines[lineNumber - 1];
  return { inMath: s?.inMath ?? false, inComment: s?.inComment ?? false };
}
