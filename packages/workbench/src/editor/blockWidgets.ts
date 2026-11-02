// Multi-line Live Preview constructs: they replace whole lines, which CodeMirror
// only allows from state fields (not view plugins): hidden frontmatter, display
// math, Mermaid diagrams and foldable callouts. Blocks are scanned when the
// document changes; decorations follow the selection (a block being edited
// shows its source). The frontmatter is the exception: it never shows in Live
// Preview (the Properties sidebar edits it); only Source mode displays it.
//
// A change rescans only around itself: from the start of the construct it touches up to the
// first line after it where the scan is back in step with the previous one; the blocks before
// and after are kept (the latter moved by the length of the change). See updateScan.
import {
  EditorState,
  RangeSet,
  StateField,
  Transaction,
  type Range,
  type Text,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { calloutToggles, isCalloutFolded, parseCalloutHead, toggleCallout } from './callouts';
import { changedSpan, frontmatterOf, FRONTMATTER_END } from './blockState';
import { QueryWidget } from '../query/widget';
import { MathWidget, MermaidWidget } from './widgets';

export type BlockKind = 'frontmatter' | 'math' | 'mermaid' | 'callout' | 'query';

export interface Block {
  kind: BlockKind;
  from: number;
  to: number;
  /** math: TeX; mermaid: diagram source; callout: fold marker. */
  data: string;
  /** callout: start of the title line (key of the fold state). */
  titlePos: number;
}

/**
 * Lines the scanner took as one unit (a fence, a $$ pair, a run of > lines), from the start of
 * the first line to the end of the last. `dep`: the end of the last line it read to decide (a run
 * of > lines ends because of the line after it), so a change up to there rescans the unit.
 */
interface Unit {
  from: number;
  to: number;
  dep: number;
}

/** What blocksField keeps: the blocks, and what an incremental rescan needs. */
export interface BlockScan {
  blocks: Block[];
  units: Unit[];
  fmLines: number;
  /** The first line is `---` and nothing closes it: any later `---` line may. */
  fmOpen: boolean;
  /** Start of a `$$` line that found no closing `$$` (at most one: it is the last `$$` line). */
  openMath: number | null;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)/;
const QUOTE = /^\s*>/;

/** Lines read by the scanner, for the performance tests. */
export const scanStats = { lines: 0 };

/**
 * Scans from line n (a line start outside any construct) to the end, or until `stop` accepts a
 * line. Returns the line it stopped at (doc.lines + 1 at the end) and the unclosed `$$` line.
 */
function scanLines(
  doc: Text,
  n: number,
  blocks: Block[],
  units: Unit[],
  stop?: (n: number) => boolean,
): { at: number; openMath: number | null } {
  let openMath: number | null = null;
  while (n <= doc.lines) {
    if (stop?.(n)) return { at: n, openMath };
    const line = doc.line(n);
    const text = line.text;
    scanStats.lines++;
    const f = FENCE.exec(text);
    if (f) {
      const char = (f[1] ?? '`').charAt(0);
      const len = (f[1] ?? '').length;
      const lang = (f[2] ?? '').toLowerCase();
      let m = n + 1;
      for (; m <= doc.lines; m++) {
        scanStats.lines++;
        const c = FENCE.exec(doc.line(m).text);
        if (c && (c[1] ?? '').startsWith(char) && (c[1] ?? '').length >= len && !(c[2] ?? ''))
          break;
      }
      if (m > doc.lines) {
        // An unclosed fence takes the rest of the document.
        units.push({ from: line.from, to: doc.length, dep: doc.length });
        return { at: doc.lines + 1, openMath };
      }
      const close = doc.line(m);
      if (lang === 'mermaid' || lang === 'query') {
        const code = doc.sliceString(
          doc.line(n + 1).from <= close.from - 1 ? doc.line(n + 1).from : line.to,
          Math.max(close.from - 1, line.to),
        );
        blocks.push({
          kind: lang === 'query' ? 'query' : 'mermaid',
          from: line.from,
          to: close.to,
          data: m - n > 1 ? code : '',
          titlePos: 0,
        });
      }
      units.push({ from: line.from, to: close.to, dep: close.to });
      n = m + 1;
      continue;
    }
    const t = text.trim();
    if (t.startsWith('$$')) {
      const count = text.split('$$').length - 1;
      if (count >= 2 && t.endsWith('$$') && t.length > 4) {
        // single line: $$ x $$ alone on its line
        blocks.push({
          kind: 'math',
          from: line.from,
          to: line.to,
          data: t.slice(2, -2).trim(),
          titlePos: 0,
        });
      } else if (count === 1) {
        // The search stops at the next line holding `$$`, which this one pairs with: searched
        // ranges never overlap, so even many unclosed `$$` lines keep the scan linear.
        let m = n + 1;
        while (m <= doc.lines && !doc.line(m).text.includes('$$')) {
          scanStats.lines++;
          m++;
        }
        if (m <= doc.lines) {
          const end = doc.line(m);
          const body = doc.sliceString(
            line.from + text.indexOf('$$') + 2,
            end.from + end.text.indexOf('$$'),
          );
          blocks.push({
            kind: 'math',
            from: line.from,
            to: end.to,
            data: body.trim(),
            titlePos: 0,
          });
          units.push({ from: line.from, to: end.to, dep: end.to });
          n = m + 1;
          continue;
        }
        openMath = line.from;
      }
      n++;
      continue;
    }
    if (QUOTE.test(text)) {
      const head = parseCalloutHead(text);
      let m = n;
      while (m + 1 <= doc.lines && QUOTE.test(doc.line(m + 1).text)) {
        scanStats.lines++;
        m++;
      }
      const last = doc.line(m);
      if (head && head.marker !== '' && m > n) {
        blocks.push({
          kind: 'callout',
          from: line.to,
          to: last.to,
          data: head.marker,
          titlePos: line.from,
        });
      }
      // The run ended because of the next line: a > added to it extends the run.
      const dep = m < doc.lines ? doc.line(m + 1).to : last.to;
      units.push({ from: line.from, to: last.to, dep });
      n = m + 1;
      continue;
    }
    n++;
  }
  return { at: doc.lines + 1, openMath };
}

/** Scans the whole document. */
function scan(doc: Text): BlockScan {
  const fm = frontmatterOf(doc);
  const blocks: Block[] = [];
  if (fm.lines > 0)
    blocks.push({
      kind: 'frontmatter',
      from: 0,
      to: doc.line(Math.min(fm.lines, doc.lines)).to,
      data: '',
      titlePos: 0,
    });
  const units: Unit[] = [];
  const { openMath } = scanLines(doc, fm.lines + 1, blocks, units);
  return { blocks, units, fmLines: fm.lines, fmOpen: fm.open, openMath };
}

/** Where a block's construct starts (a callout's block begins after its title line). */
const startOf = (b: Block): number => (b.kind === 'callout' ? b.titlePos : b.from);

const shiftBlock = (b: Block, d: number): Block => ({
  ...b,
  from: b.from + d,
  to: b.to + d,
  titlePos: b.kind === 'callout' ? b.titlePos + d : b.titlePos,
});

/**
 * The scan after a transaction, reusing the previous one. The rescan starts at the changed line,
 * or earlier at the start of a unit that read it (or at the unclosed `$$` line when the change
 * brings a `$$` that may close it); it stops at the first line past the change that the previous
 * scan also reached outside any unit, since from there both scans read the same lines in the same
 * state. A change to the frontmatter (or one that may close an open one) rescans everything.
 */
export function updateScan(prev: BlockScan, tr: Transaction): BlockScan {
  if (!tr.docChanged) return prev;
  const oldDoc = tr.startState.doc;
  const doc = tr.newDoc;
  const { fromA, toA, fromB, toB } = changedSpan(tr);
  const firstLine = oldDoc.lineAt(fromA);
  if (firstLine.number === 1 || firstLine.number <= prev.fmLines) return scan(doc);
  const changed = doc.sliceString(doc.lineAt(fromB).from, doc.lineAt(toB).to);
  if (prev.fmOpen && FRONTMATTER_END.test(changed)) return scan(doc);

  let start = firstLine.from;
  for (const u of prev.units) {
    if (u.from > toA) break;
    if (u.dep >= firstLine.from && u.from < start) start = u.from;
  }
  if (prev.openMath !== null && prev.openMath < start && changed.includes('$$'))
    start = prev.openMath;

  const delta = doc.length - oldDoc.length;
  const blocks = prev.blocks.filter((b) => startOf(b) < start);
  const units = prev.units.filter((u) => u.from < start);
  // In step again at a line start past the change that the old scan reached outside any unit.
  let k = 0;
  const inStep = (n: number): boolean => {
    const pos = doc.line(n).from;
    if (pos <= toB) return false;
    const old = pos - delta;
    while (k < prev.units.length && (prev.units[k] as Unit).to < old) k++;
    const u = prev.units[k];
    return !(u && u.from < old && old <= u.to);
  };
  const scanned = scanLines(doc, doc.lineAt(start).number, blocks, units, inStep);
  let openMath = scanned.openMath;
  if (openMath === null && prev.openMath !== null && prev.openMath < start)
    openMath = prev.openMath;
  if (scanned.at <= doc.lines) {
    const resume = doc.line(scanned.at).from - delta;
    for (const b of prev.blocks) if (startOf(b) >= resume) blocks.push(shiftBlock(b, delta));
    for (const u of prev.units)
      if (u.from >= resume)
        units.push({ from: u.from + delta, to: u.to + delta, dep: u.dep + delta });
    if (openMath === null && prev.openMath !== null && prev.openMath >= resume)
      openMath = prev.openMath + delta;
  }
  return { blocks, units, fmLines: prev.fmLines, fmOpen: prev.fmOpen, openMath };
}

/** Scans the document for blocks (pure). */
export function scanBlocks(state: EditorState): Block[] {
  return scan(state.doc).blocks;
}

/** The scan of a whole document, as blocksField computes it from scratch. */
export function scanDocument(doc: Text): BlockScan {
  return scan(doc);
}

/**
 * The range hidden in Live Preview: the frontmatter lines up to the start of the first body
 * line. Null when there is no frontmatter, or nothing follows it (it would trap the cursor).
 */
export function hiddenFrontmatter(state: EditorState): { from: number; to: number } | null {
  const fm = state.field(blocksField).blocks[0];
  if (fm?.kind !== 'frontmatter' || fm.to + 1 > state.doc.length) return null;
  return { from: 0, to: fm.to + 1 };
}

export const blocksField = StateField.define<BlockScan>({
  create: (state) => scan(state.doc),
  update: (value, tr) => updateScan(value, tr),
});

/** Decorations for the blocks, given the current selection and fold state (pure). */
export function blockDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  const editing = (from: number, to: number): boolean =>
    sel.some((r) => r.from <= to && r.to >= from);
  for (const b of state.field(blocksField).blocks) {
    switch (b.kind) {
      case 'frontmatter': {
        const hidden = hiddenFrontmatter(state);
        if (hidden) out.push(Decoration.replace({ block: true }).range(hidden.from, hidden.to));
        break;
      }
      case 'math':
        if (!editing(b.from, b.to))
          out.push(
            Decoration.replace({ widget: new MathWidget(b.data, true), block: true }).range(
              b.from,
              b.to,
            ),
          );
        break;
      case 'mermaid':
        if (!editing(b.from, b.to) && b.data.trim())
          out.push(
            Decoration.replace({ widget: new MermaidWidget(b.data), block: true }).range(
              b.from,
              b.to,
            ),
          );
        break;
      case 'query':
        if (!editing(b.from, b.to) && b.data.trim())
          out.push(
            Decoration.replace({ widget: new QueryWidget(b.data), block: true }).range(
              b.from,
              b.to,
            ),
          );
        break;
      case 'callout':
        if (isCalloutFolded(state, b.titlePos, b.data) && !editing(b.from, b.to))
          out.push(Decoration.replace({}).range(b.from, b.to));
        break;
    }
  }
  return Decoration.set(out, true);
}

const blockDecorationsField = StateField.define<DecorationSet>({
  create: (state) => blockDecorations(state),
  update: (value, tr) => {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(toggleCallout)))
      return blockDecorations(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Keeps edits out of the hidden frontmatter: a typed character at its start lands at the
 * start of the body instead, and any other change that would touch it is dropped (a change
 * replacing the whole document, such as a reload, passes).
 */
const frontmatterGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const hidden = hiddenFrontmatter(tr.startState);
  if (!hidden) return tr;
  let touches = false;
  let whole = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA >= hidden.to) whole = true;
    else if (fromA < hidden.to) touches = true;
  });
  if (!touches || whole) return tr;
  const only: { from: number; to: number; text: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
    only.push({ from: fromA, to: toA, text: inserted.toString() }),
  );
  const [c] = only;
  if (only.length === 1 && c && c.from === c.to && c.text !== '') {
    return {
      changes: { from: hidden.to, insert: c.text },
      selection: { anchor: hidden.to + c.text.length },
      userEvent: tr.annotation(Transaction.userEvent) ?? 'input',
    };
  }
  return [];
});

/** The cursor moves over the hidden frontmatter instead of entering it. */
const frontmatterAtomic = EditorView.atomicRanges.of((view) => {
  const hidden = hiddenFrontmatter(view.state);
  return hidden
    ? RangeSet.of([Decoration.replace({}).range(hidden.from, hidden.to)])
    : Decoration.none;
});

export function blockWidgets() {
  return [calloutToggles, blocksField, blockDecorationsField, frontmatterGuard, frontmatterAtomic];
}
