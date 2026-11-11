// Where a place of the Live document is in the text of the file, and the other way round (A-D2: the
// handle talks in source lines and columns). The document does not know: a block that was not touched
// is the file's own text, one that was is written again, so the answer comes from the text the layer
// composes for the document, with a marker typed at the place.
//
//   locOf(doc, pos)       the line and column in the text of `doc` where the position `pos` is written
//   posAt(doc, loc)       the nearest position of the document to a line and column of its text
//
// The marker is a private-use character in the text of the place (a character no Markdown construct
// touches). Only the block it is typed in is written again, the rest is the file as it is, so the line
// is exact up to that block; inside it the column is approximate (a list marker, a quote prefix or a
// table cell is not text of the document) and a block that is written differently from the file's may
// move it by a line. That is the "exact line, approximate column" of ADR-0049.
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { EditorState, Selection } from '@milkdown/kit/prose/state';

/** The one marker. */
const MARK = '';

export interface Loc {
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 units. */
  col: number;
}

/** What positions needs of the session: the text of a document. */
export interface TextOf {
  text(doc: PMNode): string;
}

/** The line and column of an offset of a text. */
export function locInText(text: string, offset: number): Loc {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++;
  const start = text.lastIndexOf('\n', at - 1) + 1;
  return { line, col: at - start + 1 };
}

/** The offset of a line and column of a text, clamped to the text (a line past the end is the end). */
export function offsetInText(text: string, loc: Loc): number {
  let start = 0;
  for (let n = 1; n < loc.line; n++) {
    const next = text.indexOf('\n', start);
    if (next < 0) return text.length;
    start = next + 1;
  }
  const nl = text.indexOf('\n', start);
  const end = nl < 0 ? text.length : nl > start && text[nl - 1] === '\r' ? nl - 1 : nl;
  return Math.min(end, start + Math.max(1, loc.col) - 1);
}

/** A position near `pos` where text can be typed (inside a textblock), or null when the document has none. */
function inText(doc: PMNode, pos: number): number | null {
  const p = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(p);
  if ($pos.parent.inlineContent) return p;
  try {
    const near = Selection.near($pos, 1);
    return near.$head.parent.inlineContent ? near.head : null;
  } catch {
    return null;
  }
}

/** A position of the document and which side of a mark boundary the marker goes on there. */
export interface At {
  pos: number;
  /**
   * At the edge of a mark (`**hello**`) the marker is typed inside the text that follows (1) or the one
   * that comes before (-1), so that the start of a selection is after the opening `**` and its end
   * before the closing one; 0 takes the marks the editor would type with.
   */
  bias?: -1 | 0 | 1;
}

/** The text of `doc` with a marker typed at each position; null when it cannot be. */
function withMarkers(doc: PMNode, ats: At[]): { doc: PMNode; marks: string[] } | null {
  const places = ats.map((a) => inText(doc, a.pos));
  if (places.some((p) => p === null)) return null;
  const order = [...places.keys()].sort(
    (x, y) => (places[y] as number) - (places[x] as number) || y - x,
  );
  const marks = ats.map((_, i) => MARK + String.fromCharCode(0xe100 + i));
  let tr = EditorState.create({ doc }).tr;
  try {
    for (const i of order) {
      const at = places[i] as number;
      const bias = ats[i]?.bias ?? 0;
      const $at = doc.resolve(at);
      let typed = $at.marks();
      if (bias > 0 && $at.nodeAfter?.isText) typed = $at.nodeAfter.marks;
      else if (bias < 0 && $at.nodeBefore?.isText) typed = $at.nodeBefore.marks;
      tr = tr.insert(at, doc.type.schema.text(marks[i] as string, typed));
    }
  } catch {
    return null;
  }
  return { doc: tr.doc, marks };
}

/** The lines and columns, in the text of `doc`, of some places of it. */
export function locsOf(session: TextOf, doc: PMNode, ats: At[]): Loc[] {
  const first: Loc = { line: 1, col: 1 };
  const m = withMarkers(doc, ats);
  if (!m) return ats.map(() => first);
  let text = session.text(m.doc);
  // Where the markers are, in the order they are in the text; then the text without them.
  const found = m.marks.map((mark) => text.indexOf(mark));
  if (found.some((i) => i < 0)) return ats.map(() => first);
  const out = found.map((at, i) => {
    // the markers before this one in the text are not part of its offset
    const before = found.filter((other) => other < at).length * 2;
    return { at: at - before, i };
  });
  for (const mark of m.marks) text = text.replace(mark, '');
  const locs = new Array<Loc>(ats.length);
  for (const { at, i } of out) locs[i] = locInText(text, at);
  return locs;
}

export function locOf(session: TextOf, doc: PMNode, pos: number): Loc {
  return locsOf(session, doc, [{ pos }])[0] as Loc;
}

/** The positions of the document where each textblock begins, in order. */
export function textblockStarts(doc: PMNode): number[] {
  const starts: number[] = [];
  doc.descendants((node, pos) => {
    if (node.inlineContent) {
      starts.push(pos + 1);
      return false;
    }
    return true;
  });
  return starts;
}

const before = (a: Loc, b: Loc): boolean =>
  a.line < b.line || (a.line === b.line && a.col <= b.col);

/**
 * The position of the document nearest to a line and column of its text, never past it: the last
 * textblock that begins at or before the line, then the last place of that block that is not past the
 * column. Both are binary searches over `locOf`, which is monotonic: each step writes the document
 * once with a marker, so what the document puts in the text of a block that it does not hold itself
 * (the `**` of a mark, the `[[` of a link, the `- ` of an item) is counted as the file has it.
 */
export function posAt(session: TextOf, doc: PMNode, loc: Loc): number {
  const starts = textblockStarts(doc);
  if (starts.length === 0) return Math.min(1, doc.content.size);
  let lo = 0;
  let hi = starts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (before(locOf(session, doc, starts[mid] as number), loc)) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const start = starts[best] as number;
  const end = start + doc.resolve(start).parent.content.size;
  let low = start;
  let high = end;
  let found = start;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (before(locOf(session, doc, mid), loc)) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  // A line that begins with what the document does not hold (`## `, `- `, `> `) has no place at its
  // first column: the first place on that line is the one that is asked for, not the end of the line before.
  if (locOf(session, doc, found).line < loc.line) {
    const next = found < end ? found + 1 : (starts[best + 1] ?? -1);
    if (next >= 0 && locOf(session, doc, next).line === loc.line) return next;
  }
  return found;
}
