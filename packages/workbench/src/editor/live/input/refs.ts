// References typed or pasted as text (W5 review N2).
//
// A reference to a footnote (`[^1]`) or to a link definition (`[text][ref]`) is what the file reads from
// the source text, and the layer holds it as a `raw_inline` atom (ofm/remark.ts): written back as it is.
// Typed or pasted as text it would stay a text node, which the serializer writes escaped (`\[^1]`: the
// invariant of ofm/escape.ts, plain text never reads as a construct), so a footnote typed in Live would
// never be one. So the references go in as the atom the file would give them:
//
//   [^id]       always (a footnote is `[^id]`, with the definition written before or after it)
//   [t][r]      when the note has the definition `[r]:`, which is what makes `[t][r]` a link and not the
//   [t][]       text of an index (`a[i][j]`); without one it stays text, as CommonMark reads it
//
// Where the text came from a backslash escape (`\[^1]` pasted as written) it is the text it says.
import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { $inputRule } from '@milkdown/kit/utils';
import { plainText } from './rules';

/** A footnote reference ending a text. */
const FOOTNOTE_TYPED = /(?<![\\^])\[\^[^\]\s[|]+\]$/;
/** A reference link or image ending a text: `[text][label]`, `![text][label]`, `[label][]`. */
const LINK_TYPED = /(?<![\\\]])(!?)\[([^\][\n|]+)\]\[([^\][\n|]*)\]$/;
/** The same two, anywhere in a text. */
const FOOTNOTE_ANY = /(?<![\\^])\[\^[^\]\s[|]+\]/g;
const LINK_ANY = /(?<![\\\]])!?\[([^\][\n|]+)\]\[([^\][\n|]*)\]/g;

const DEFINITION = /^[ >]*\[([^\]\n]+)\]:/gm;

/** A label as CommonMark matches it: blanks folded, case folded. */
export const labelOf = (raw: string): string => raw.replace(/\s+/g, ' ').trim().toLowerCase();

/** The labels of the link definitions (and footnote definitions: `^1`) the raw blocks of `doc` hold. */
export function definedLabels(doc: PMNode, into: Set<string> = new Set()): Set<string> {
  doc.descendants((n) => {
    if (n.type.name === 'raw_block') {
      for (const m of String(n.attrs['raw']).matchAll(DEFINITION)) into.add(labelOf(m[1] ?? ''));
      return false;
    }
    return true;
  });
  return into;
}

/** The label a reference link of the source `text` points at (its own text when the label is empty). */
const linkLabel = (text: string, label: string): string => labelOf(label === '' ? text : label);

/**
 * The reference that ends at `end` in `tr.doc`, as the atom of its source: `tr` edited, or null when
 * there is none, when it is not plain text, or when its definition is not in the note. The input rule
 * and typing over an auto-paired `]` (autopair.ts) share it: the `]` is in `tr` already.
 */
export function refFromText(tr: Transaction, end: number): Transaction | null {
  const type = tr.doc.type.schema.nodes['raw_inline'];
  if (!type) return null;
  const $end = tr.doc.resolve(end);
  const parent = $end.parent;
  if (!parent.inlineContent || parent.type.spec.code) return null;
  const before = parent.textBetween(0, $end.parentOffset, undefined, '￼');
  let length = FOOTNOTE_TYPED.exec(before)?.[0].length ?? 0;
  if (length === 0) {
    const m = LINK_TYPED.exec(before);
    if (!m || !definedLabels(tr.doc).has(linkLabel(m[2] ?? '', m[3] ?? ''))) return null;
    length = m[0].length;
  }
  const start = end - length;
  if (!plainText(tr.doc, start, end)) return null;
  const raw = tr.doc.textBetween(start, end);
  // the atom keeps the marks of the text it replaces: a footnote typed in `**ab**` or in the text of a
  // link is still inside the bold run and the link (the file reads it so)
  const marks = (tr.doc.nodeAt(start) ?? tr.doc.resolve(start).nodeBefore)?.marks;
  const node = type.create({ raw }, null, marks);
  tr.replaceWith(start, end, node);
  return tr.setSelection(TextSelection.create(tr.doc, start + node.nodeSize));
}

/** The input rule: the `]` that completes a reference makes it the atom of its source. */
export const refRule = $inputRule(
  () =>
    new InputRule(/\]$/, (state, _match, start, end) => {
      if (start > end) return null;
      const $end = state.doc.resolve(end);
      const inCode = (state.storedMarks ?? $end.marks()).some((m) => m.type.spec.code);
      if (inCode) return null;
      return refFromText(state.tr.insertText(']', end), end + 1);
    }),
);

/** Whether `src` writes the reference `raw` (as the text of a parse reads it) with a bracket escaped: `\\[^1]`. */
export function escapedIn(src: string, raw: string): boolean {
  if (!src.includes('\\')) return false;
  return (
    src.includes(`\\${raw}`) ||
    src.includes(raw.replace(/\]/g, '\\]')) ||
    src.includes(raw.replace(/[[\]]/g, '\\$&'))
  );
}

/** The text node `node` with the references it holds cut out as atoms. */
function splitText(
  node: PMNode,
  type: PMNode['type'],
  defs: ReadonlySet<string>,
  skip: (raw: string) => boolean,
): PMNode[] {
  const text = node.text ?? '';
  const found: { from: number; to: number }[] = [];
  for (const m of text.matchAll(FOOTNOTE_ANY)) {
    if (!skip(m[0])) found.push({ from: m.index, to: m.index + m[0].length });
  }
  for (const m of text.matchAll(LINK_ANY)) {
    if (defs.has(linkLabel(m[1] ?? '', m[2] ?? '')) && !skip(m[0])) {
      found.push({ from: m.index, to: m.index + m[0].length });
    }
  }
  if (found.length === 0) return [node];
  found.sort((a, b) => a.from - b.from);
  const out: PMNode[] = [];
  let at = 0;
  for (const f of found) {
    if (f.from < at) continue; // one inside another: the first wins
    if (f.from > at) out.push(node.cut(at, f.from));
    // the atom is inside the marks the text had (a bold run, say), as the file reads it
    out.push(type.create({ raw: text.slice(f.from, f.to) }, null, node.marks));
    at = f.to;
  }
  if (at < text.length) out.push(node.cut(at));
  return out;
}

/**
 * `node` (what a paste parsed to) with the references that stayed text turned into atoms: the ones the
 * rules above give typed text. Code, links and what is not a plain text node are left alone, and so is a
 * reference for which `skip` answers true (one the source wrote escaped).
 */
export function rawRefs(
  node: PMNode,
  defs: ReadonlySet<string>,
  skip: (raw: string) => boolean = () => false,
): PMNode {
  const type = node.type.schema.nodes['raw_inline'];
  if (!type || node.isLeaf || node.type.spec.code) return node;
  if (!node.inlineContent) {
    const kids: PMNode[] = [];
    node.forEach((c) => kids.push(rawRefs(c, defs, skip)));
    return node.copy(Fragment.fromArray(kids));
  }
  const out: PMNode[] = [];
  node.forEach((c) => {
    const plain = c.isText && !c.marks.some((m) => m.type.spec.code || m.type.name === 'link');
    if (plain) out.push(...splitText(c, type, defs, skip));
    else out.push(c);
  });
  return node.copy(Fragment.fromArray(out));
}
