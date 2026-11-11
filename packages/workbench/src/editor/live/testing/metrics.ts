// The measurements of the A gate, on the corpus of corpus.ts. The tests assert on them and
// `yarn workspace @memobrain/workbench run live:metrics` prints them. Test support only.
import { extract } from '@memobrain/markdown';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import {
  AllSelection,
  EditorState,
  TextSelection,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { lift, wrapIn } from '@milkdown/kit/prose/commands';
import { renderMarkdown } from '../../../reading/render';
import type { LiveCore } from '../headless';
import { LiveSession, captureErrors } from '../fidelity/session';
import { makeComposer, type Composer } from '../fidelity/compose';
import { splitEnvelope } from '../fidelity/envelope';
import { ADVERSARIAL, type Criterion } from './adversarial';
import { fullCorpus, nonAdversarial, type Sample } from './corpus';

const POSITIONS = new Set(['line', 'start', 'end', 'targetStart', 'targetEnd', 'frontmatterLines']);
const noBom = (s: string): string => s.replace(/^\uFEFF/, '');
const lf = (s: string): string => s.replaceAll('\r\n', '\n');

/**
 * extract() as the index stores it: the structure, not where it is, and with LF line ends. The index
 * (Go) reads a CRLF file as the LF one; `extract()` of the TS mirror does not: it keeps the `\r` in what
 * it matches line by line (a heading's closing `#` sequence is not stripped, no task is found). A note
 * is composed as LF and takes its line ends back at the end, so the comparison is on the LF text.
 */
export function shape(src: string): string {
  return JSON.stringify(extract('t', lf(noBom(src))), (k, v: unknown) =>
    POSITIONS.has(k) ? undefined : v,
  );
}
/** extract() with the positions: lines and offsets too. */
export function strictShape(src: string): string {
  return JSON.stringify(extract('t', noBom(src)));
}
const ws = (s: string): string => s.replace(/\s+/g, ' ');

export function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 30), i + 50));
  return `@${i} ${cut(a)} | ${cut(b)}`;
}

export interface Failure {
  id: string;
  /** What differs, in a few words, to group the failures. */
  cause: string;
  detail: string;
}

export interface OpenResult {
  sample: Sample;
  session: LiveSession | null;
  refused: string | null;
}

export function openAll(core: LiveCore, samples: Sample[]): OpenResult[] {
  const composer = makeComposer(core);
  return samples.map((sample) => {
    const r = LiveSession.open(core, sample.raw, composer);
    return r.ok
      ? { sample, session: r.session, refused: null }
      : {
          sample,
          session: null,
          refused: r.reason + (r.detail ? `: ${r.detail.slice(0, 80)}` : ''),
        };
  });
}

// ------------------------------------------------------------------------------------- C1

export interface C1 {
  n: number;
  refused: number;
  /** extract() equal (positions left out), HTML of Reading equal (whitespace collapsed). */
  extractSame: number;
  htmlSame: number;
  bothSame: number;
  /** The strict forms: positions kept, the very bytes of the HTML. */
  extractStrict: number;
  htmlStrict: number;
  /** The text is byte for byte the file. */
  bytesSame: number;
  /** Every line end of the output is the file's (CRLF files stay CRLF). */
  eolKept: number;
  failures: Failure[];
}

/**
 * Criterion 1: with every block forced dirty, extract() and the Reading HTML do not change.
 * `extractSame` leaves the positions out (lines and offsets of the entries): a text written again
 * moves what follows it. With the positions (`extractStrict`) it is 1044/1065 on the non adversarial
 * corpus; the 21 files that differ differ only by offsets and lines, never by structure.
 */
export function measureC1(opened: OpenResult[]): C1 {
  const res: C1 = {
    n: 0,
    refused: 0,
    extractSame: 0,
    htmlSame: 0,
    bothSame: 0,
    extractStrict: 0,
    htmlStrict: 0,
    bytesSame: 0,
    eolKept: 0,
    failures: [],
  };
  for (const { sample, session, refused } of opened) {
    res.n++;
    if (!session) {
      res.refused++;
      res.failures.push({
        id: sample.id,
        cause: `refused (${refused?.split(':')[0]})`,
        detail: refused ?? '',
      });
      continue;
    }
    const out = session.text(session.doc, { forceDirty: true });
    if (out === sample.raw) res.bytesSame++;
    const crlf = session.envelope.eol === '\r\n';
    if (!crlf || !/(^|[^\r])\n/.test(out)) res.eolKept++;
    // the files are compared as the app reads them; CRLF is checked on its own (eolKept)
    const a = lf(sample.raw);
    const b = lf(out);
    const e = shape(a) === shape(b);
    const h = ws(renderMarkdown(a)) === ws(renderMarkdown(b));
    if (e) res.extractSame++;
    if (h) res.htmlSame++;
    if (e && h) res.bothSame++;
    if (strictShape(a) === strictShape(b)) res.extractStrict++;
    if (renderMarkdown(a) === renderMarkdown(b)) res.htmlStrict++;
    if (!e || !h) {
      res.failures.push({
        id: sample.id,
        cause: `${e ? '' : 'extract'}${!e && !h ? '+' : ''}${h ? '' : 'html'}`,
        detail: `${JSON.stringify(a.slice(0, 70))} => ${JSON.stringify(b.slice(0, 70))} ${
          e ? firstDiff(renderMarkdown(a), renderMarkdown(b)) : firstDiff(shape(a), shape(b))
        }`.slice(0, 400),
      });
    }
  }
  return res;
}

// ------------------------------------------------------------------------------------- C2

/** Lines removed and added, as `git diff` would count them: the larger of the two. */
export function changedLines(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const xm = x.slice(p, x.length - s);
  const ym = y.slice(p, y.length - s);
  const n = xm.length;
  const m = ym.length;
  if (n === 0 || m === 0) return Math.max(n, m);
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] =
        xm[i] === ym[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const lcs = dp[0]![0]!;
  return Math.max(n - lcs, m - lcs);
}

/** A seeded generator (mulberry32): the measurement is the same on every run. */
export function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** The places where a character can be typed: inside the text of a text block. */
export function typingSites(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      const step = Math.max(1, Math.floor(node.text.length / 3));
      for (let i = 0; i <= node.text.length; i += step) out.push(pos + i);
    }
    return true;
  });
  return out;
}

export interface C2 {
  n: number;
  le1: number;
  pct: number;
  buckets: Record<string, number>;
  failures: Failure[];
}

/** Criterion 2: one character typed in a text node changes at most one line (in >= 95% of the cases). */
export function measureC2Insert(opened: OpenResult[], perFile = 6): C2 {
  const rand = rng(42);
  const res: C2 = { n: 0, le1: 0, pct: 0, buckets: {}, failures: [] };
  for (const { sample, session } of opened) {
    if (!session) continue;
    const sites = typingSites(session.doc);
    for (let k = 0; k < Math.min(perFile, sites.length); k++) {
      const pos = sites[Math.floor(rand() * sites.length)]!;
      const tr = EditorState.create({ doc: session.doc }).tr.insertText('x', pos);
      if (tr.doc.eq(session.doc)) continue;
      const out = lf(session.text(tr.doc));
      const lines = changedLines(lf(sample.raw), out);
      res.n++;
      if (lines <= 1) res.le1++;
      const key = lines >= 6 ? '6+' : String(lines);
      res.buckets[key] = (res.buckets[key] ?? 0) + 1;
      if (lines > 1) {
        res.failures.push({
          id: sample.id,
          cause: session.doc.resolve(pos).node(1).type.name,
          detail: `+x@${pos} ${lines} lines ${firstDiff(lf(sample.raw), out)}`.slice(0, 300),
        });
      }
    }
  }
  res.pct = res.n === 0 ? 0 : +((100 * res.le1) / res.n).toFixed(2);
  return res;
}

/** Ticks one task of a nested list of `count` items and returns the lines changed. */
export function tickTask(core: LiveCore, raw: string, which: 'first' | 'middle' | 'last'): number {
  const r = LiveSession.open(core, raw);
  if (!r.ok) return -1;
  const { session } = r;
  const items: number[] = [];
  session.doc.descendants((n, pos) => {
    if (n.type.name === 'list_item') items.push(pos);
    return true;
  });
  const at =
    which === 'first'
      ? items[1]!
      : which === 'last'
        ? items[items.length - 1]!
        : items[Math.floor(items.length / 2)]!;
  const node = session.doc.nodeAt(at)!;
  const tr = EditorState.create({ doc: session.doc }).tr.setNodeMarkup(at, undefined, {
    ...node.attrs,
    checked: true,
  });
  return changedLines(raw, session.text(tr.doc));
}

// ------------------------------------------------------------------------------------- C3

export interface C3 {
  n: number;
  idempotent: number;
  failures: Failure[];
}

/** Criterion 3: ten round trips (open, write every block again, open ...) give the same text. */
export function measureC3(core: LiveCore, samples: Sample[], rounds = 10): C3 {
  const composer = makeComposer(core);
  const res: C3 = { n: 0, idempotent: 0, failures: [] };
  for (const sample of samples) {
    let cur = sample.raw;
    const seen: string[] = [];
    let refused = false;
    for (let i = 0; i < rounds; i++) {
      const r = LiveSession.open(core, cur, composer);
      if (!r.ok) {
        refused = true;
        break;
      }
      cur = r.session.text(r.session.doc, { forceDirty: true });
      seen.push(cur);
    }
    res.n++;
    if (refused) {
      res.failures.push({ id: sample.id, cause: 'refused', detail: '' });
    } else if (seen.every((x) => x === seen[0])) {
      res.idempotent++;
    } else {
      const i = seen.findIndex((x) => x !== seen[0]);
      res.failures.push({
        id: sample.id,
        cause: i < 2 ? 'unstable after the first write' : 'drift',
        detail: firstDiff(seen[0]!, seen[i]!).slice(0, 240),
      });
    }
  }
  return res;
}

// ------------------------------------------------------------------------------------- C4

export interface C4 {
  n: number;
  refused: number;
  /** Composing the loaded document is not the file (a block would be written without input). */
  notIdentity: number;
  /** The document after the selection and the hover is not the loaded one, or its text is not the file. */
  changedBySelection: number;
  changedByHover: number;
  /** The text of the document after all of it is not the file, byte for byte. */
  dirtyAtEnd: number;
  failures: Failure[];
}

/**
 * Criterion 4: no block becomes dirty without input. Each file is loaded into the editor (the
 * plugins that adjust a document on load run), then the selection moves and the mouse goes over
 * every element: the document must stay the loaded one, and its text the file, byte for byte.
 */
export function measureC4(core: LiveCore, samples: Sample[]): C4 {
  const composer = makeComposer(core);
  const res: C4 = {
    n: 0,
    refused: 0,
    notIdentity: 0,
    changedBySelection: 0,
    changedByHover: 0,
    dirtyAtEnd: 0,
    failures: [],
  };
  const view = core.view;
  for (const sample of samples) {
    const r = LiveSession.open(core, sample.raw, composer);
    res.n++;
    if (!r.ok) {
      res.refused++;
      res.failures.push({ id: sample.id, cause: `refused (${r.reason})`, detail: r.detail ?? '' });
      continue;
    }
    const { session } = r;
    const loaded = view.state.doc;
    if (session.text(loaded) !== sample.raw) {
      res.notIdentity++;
      res.failures.push({
        id: sample.id,
        cause: 'load',
        detail: firstDiff(sample.raw, session.text(loaded)),
      });
      continue;
    }
    const size = loaded.content.size;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
    if (size > 2) {
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, Math.min(4, size - 1))),
      );
    }
    if (!view.state.doc.eq(loaded)) {
      res.changedBySelection++;
      res.failures.push({ id: sample.id, cause: 'selection', detail: '' });
    }
    for (const el of Array.from(view.dom.querySelectorAll('*')).slice(0, 80)) {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    }
    if (!view.state.doc.eq(loaded)) {
      res.changedByHover++;
      res.failures.push({ id: sample.id, cause: 'hover', detail: '' });
    }
    if (session.text(view.state.doc) !== sample.raw) {
      res.dirtyAtEnd++;
      res.failures.push({
        id: sample.id,
        cause: 'text',
        detail: firstDiff(sample.raw, session.text(view.state.doc)),
      });
    }
  }
  return res;
}

// ------------------------------------------------------------------------------------- C1-edit

/** The characters a user types that Markdown reads as syntax, and a plain one. */
export const EDIT_CHARS = [
  'x',
  '*',
  '_',
  '[',
  ']',
  '#',
  '|',
  '`',
  '>',
  '-',
  '$',
  '%',
  '=',
  '^',
  '~',
];

export interface C1Edit {
  /** Edits compared (the document changed). */
  n: number;
  refused: number;
  /** Same Markdown tree (positions left out), same extract() (positions left out), same Reading HTML. */
  treeSame: number;
  extractSame: number;
  htmlSame: number;
  same: number;
  /** Edits whose forced text the parser of a development build cannot read (it asserts): both sides are then unreadable. */
  unreadable: number;
  /** Edits by operation, and the ones that differ by operation. */
  byOp: Record<string, number>;
  failuresByOp: Record<string, number>;
  failures: Failure[];
}

/** The Markdown tree of a text, positions left out: what Reading builds its HTML from. */
function treeShape(core: LiveCore, md: string): string {
  try {
    return JSON.stringify(core.parseTree(noBom(md)), (k, v: unknown) =>
      k === 'position' ? undefined : v,
    );
  } catch (e) {
    // the parser of a development build asserts on a few corners; a text it cannot read is a text
    return `THROWS ${String(e).slice(0, 60)}`;
  }
}

/** The Reading HTML of two texts is the same (whitespace collapsed); a text that Reading cannot read is not the same. */
function renderSame(a: string, b: string): boolean {
  const html = (md: string): string => {
    try {
      return ws(renderMarkdown(md));
    } catch (e) {
      return `THROWS ${String(e).slice(0, 60)}`;
    }
  };
  return html(a) === html(b);
}

/** The ancestors of a position as a path (`blockquote>list_item>paragraph`): the kind of place of an edit. */
function contextOf(doc: PMNode, pos: number): string {
  const $p = doc.resolve(pos);
  const out: string[] = [];
  for (let d = 1; d <= $p.depth; d++) out.push($p.node(d).type.name);
  return out.join('>');
}

interface EditOp {
  name: string;
  tr: Transaction;
}

/**
 * The sample of edits of one document, all of them on the path of an edit of the real editor
 * (typing, Enter, Backspace, a selection deleted, a task ticked): an Enter in every kind of place
 * the document has, then `perFile` operations at random places: a normal character or one that
 * Markdown reads as syntax, a newline in the text, one character or a range deleted, a task ticked.
 */
export function sampleEdits(
  doc: PMNode,
  rand: () => number,
  perFile: number,
  parse?: (md: string) => PMNode,
): EditOp[] {
  const sites = typingSites(doc);
  const ops: EditOp[] = [];
  const start = (): Transaction => EditorState.create({ doc }).tr;
  const guarded = (name: string, build: (tr: Transaction) => Transaction): void => {
    try {
      const tr = build(start());
      tr.doc.check(); // a transaction that leaves an invalid document is not an edit a user can make
      if (!tr.doc.eq(doc)) ops.push({ name, tr });
    } catch {
      // a step that does not fit the schema is not an edit a user can make
    }
  };
  // Enter, once in every kind of place (the path of ancestors) that has text
  const seen = new Set<string>();
  for (const pos of sites) {
    const ctx = contextOf(doc, pos);
    if (seen.has(ctx) || seen.size >= 12) continue;
    seen.add(ctx);
    guarded('enter', (tr) => tr.split(pos));
    // in a list item Enter splits the item (the keymap does it at depth 2), not only its paragraph
    if (ctx.endsWith('list_item>paragraph')) guarded('enter-item', (tr) => tr.split(pos, 2));
  }
  if (sites.length > 0) {
    for (let k = 0; k < perFile; k++) {
      const pos = sites[Math.floor(rand() * sites.length)]!;
      const other = sites[Math.floor(rand() * sites.length)]!;
      switch (k % 6) {
        case 0:
          if (contextOf(doc, pos).endsWith('list_item>paragraph') && rand() < 0.5) {
            guarded('enter-item', (tr) => tr.split(pos, 2));
          } else {
            guarded('enter', (tr) => tr.split(pos));
          }
          break;
        case 1:
          guarded('type', (tr) =>
            tr.insertText(EDIT_CHARS[Math.floor(rand() * EDIT_CHARS.length)]!, pos),
          );
          break;
        case 2:
          guarded('newline', (tr) => tr.insertText('\n', pos));
          break;
        case 3:
          guarded('delete-char', (tr) => tr.delete(pos, Math.min(pos + 1, doc.content.size)));
          break;
        case 4:
          guarded('delete-range', (tr) => tr.delete(Math.min(pos, other), Math.max(pos, other)));
          break;
        default:
          guarded('type', (tr) =>
            tr.insertText(EDIT_CHARS[(k + Math.floor(rand() * 7)) % EDIT_CHARS.length]!, pos),
          );
      }
    }
  }
  if (parse) structuralEdits(doc, rand, parse, guarded, sites);
  // a task ticked (and one item made a task)
  const items: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'list_item') items.push(pos);
    return true;
  });
  const tasks = items.filter((p) => doc.nodeAt(p)!.attrs['checked'] !== null);
  const flip = tasks.length > 0 ? tasks[Math.floor(rand() * tasks.length)]! : undefined;
  if (flip !== undefined) {
    const node = doc.nodeAt(flip)!;
    guarded('tick', (tr) =>
      tr.setNodeMarkup(flip, undefined, { ...node.attrs, checked: !node.attrs['checked'] }),
    );
  } else if (items.length > 0) {
    const at = items[Math.floor(rand() * items.length)]!;
    const node = doc.nodeAt(at)!;
    guarded('tick', (tr) => tr.setNodeMarkup(at, undefined, { ...node.attrs, checked: false }));
  }
  return ops;
}

/** The blocks a user pastes or drops between two blocks: what can change the way its neighbours read. */
export const PASTED_BLOCKS = [
  '---',
  '$$\nx\n$$',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '%%\nc\n%%',
  '[ref]: http://x.y',
  '- new',
  '1. new',
  '1) new\n2) b',
  'para text',
  '# H',
  '> q',
  '```\ncode\n```',
];

/**
 * The positions between two blocks (any depth; between the items of a list there are none to paste at,
 * and a table takes no block: its cells are inline).
 */
export function blockBoundaries(doc: PMNode): number[] {
  const out: number[] = [];
  const visit = (node: PMNode, base: number): void => {
    if (node.isTextblock || node.isLeaf || node.type.name === 'table') return;
    const isList = node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
    let off = base;
    for (let i = 0; i <= node.childCount; i++) {
      if (!isList) out.push(off);
      if (i < node.childCount) {
        visit(node.child(i), off + 1);
        off += node.child(i).nodeSize;
      }
    }
  };
  visit(doc, 0);
  return out;
}

/**
 * The structural edits of the editor: a block pasted between two blocks, a block deleted (Backspace
 * or Delete on an emptied one), a block type changed (heading, paragraph), a paragraph lifted out of
 * its quote or item, a paragraph wrapped in a quote. Each is what a command of the editor does.
 */
function structuralEdits(
  doc: PMNode,
  rand: () => number,
  parse: (md: string) => PMNode,
  guarded: (name: string, build: (tr: Transaction) => Transaction) => void,
  sites: number[],
): void {
  const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
  const bounds = blockBoundaries(doc);
  for (let k = 0; k < 3 && bounds.length > 0; k++) {
    const at = pick(bounds)!;
    const md = PASTED_BLOCKS[Math.floor(rand() * PASTED_BLOCKS.length)]!;
    guarded('paste-block', (tr) => tr.insert(at, parse(md + '\n').content));
  }
  // a block deleted, at any depth, with the boundary it leaves
  const blocks: [number, number][] = [];
  doc.descendants((node, pos) => {
    if (node.isBlock && node.type.name !== 'list_item') blocks.push([pos, pos + node.nodeSize]);
    return node.type.name !== 'table';
  });
  for (let k = 0; k < 2 && blocks.length > 0; k++) {
    const [from, to] = pick(blocks)!;
    guarded('delete-block', (tr) => tr.delete(from, to));
  }
  // a block copied and pasted right after itself (the same block twice: what is next to it reads against it)
  for (let k = 0; k < 2 && blocks.length > 0; k++) {
    const [from, to] = pick(blocks)!;
    guarded('dup-block', (tr) => tr.insert(to, doc.slice(from, to).content));
  }
  // the text of a paragraph deleted, which leaves it empty: the block after it is read against nothing
  for (let k = 0; k < 2 && sites.length > 0; k++) {
    const $site = doc.resolve(pick(sites)!);
    if ($site.parent.content.size > 0) {
      guarded('clear-text', (tr) => tr.delete($site.start(), $site.end()));
    }
  }
  const schema = doc.type.schema;
  const paragraph = schema.nodes['paragraph']!;
  const heading = schema.nodes['heading']!;
  const quote = schema.nodes['blockquote']!;
  const at = pick(sites);
  if (at === undefined) return;
  const $at = doc.resolve(at);
  const textblock = $at.parent.type.name;
  const run = (
    name: string,
    cmd: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
  ): void => {
    guarded(name, () => {
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, at) });
      let out: Transaction | null = null;
      cmd(state, (t) => {
        out = t;
      });
      if (!out) throw new Error('the command does nothing here');
      return out;
    });
  };
  if (textblock === 'paragraph') {
    guarded('block-type', (tr) =>
      tr.setBlockType(at, at, heading, { level: 1 + Math.floor(rand() * 2) }),
    );
    run('wrap-quote', wrapIn(quote));
  } else if (textblock === 'heading') {
    guarded('block-type', (tr) => tr.setBlockType(at, at, paragraph));
  }
  run('lift', lift);
}

/**
 * Criterion C1-edit: the real path of an edit (`text(doc)`: patchLines, spliceCode, composeContainer,
 * writeNew) gives a text with the same meaning as the one of `text(doc, {forceDirty: true})` of the
 * same edited document: the same Markdown tree, the same extract() and the same Reading HTML. Both
 * comparisons leave the positions out (lines, offsets): a text written again moves things, and the
 * strict extract() of C1 differs in 21 files for that alone (see `C1.extractStrict`).
 */
export function measureC1Edit(
  core: LiveCore,
  opened: OpenResult[],
  perFile = 12,
  seed = 2024,
): C1Edit {
  const rand = rng(seed);
  const res: C1Edit = {
    n: 0,
    refused: 0,
    treeSame: 0,
    extractSame: 0,
    htmlSame: 0,
    same: 0,
    unreadable: 0,
    byOp: {},
    failuresByOp: {},
    failures: [],
  };
  for (const { sample, session } of opened) {
    if (!session) {
      res.refused++;
      continue;
    }
    for (const { name, tr } of sampleEdits(session.doc, rand, perFile, (md) => core.parse(md))) {
      compareEdit(core, res, sample, session, name, tr.doc);
    }
  }
  return res;
}

/** Records the comparison of the edit path and the forced path for one edited document. */
function compareEdit(
  core: LiveCore,
  res: C1Edit,
  sample: Sample,
  session: LiveSession,
  name: string,
  d: PMNode,
): void {
  let edit: string;
  let force: string;
  try {
    edit = lf(session.text(d));
    force = lf(session.text(d, { forceDirty: true }));
  } catch (e) {
    res.n++;
    res.byOp[name] = (res.byOp[name] ?? 0) + 1;
    res.failuresByOp[name] = (res.failuresByOp[name] ?? 0) + 1;
    res.failures.push({ id: sample.id, cause: `${name}: throws`, detail: String(e).slice(0, 200) });
    return;
  }
  res.n++;
  res.byOp[name] = (res.byOp[name] ?? 0) + 1;
  const treeEdit = treeShape(core, edit);
  const treeForce = treeShape(core, force);
  if (treeForce.startsWith('THROWS')) res.unreadable++;
  const t = treeEdit === treeForce;
  const e = shape(edit) === shape(force);
  const h = renderSame(edit, force);
  if (t) res.treeSame++;
  if (e) res.extractSame++;
  if (h) res.htmlSame++;
  if (t && e && h) {
    res.same++;
  } else {
    res.failuresByOp[name] = (res.failuresByOp[name] ?? 0) + 1;
    res.failures.push({
      id: sample.id,
      cause: `${name}: ${t ? '' : 'tree '}${e ? '' : 'extract '}${h ? '' : 'html'}`.trim(),
      detail:
        `${JSON.stringify(sample.raw.slice(0, 80))} edit ${JSON.stringify(edit.slice(0, 120))} | force ${JSON.stringify(force.slice(0, 120))}`.slice(
          0,
          500,
        ),
    });
  }
}

/**
 * What Reading prepares before it reads a note (`%%` comments, `\\[[`, `\\^[`) and how it follows a
 * fence reaches blocks far from the one an edit touches: a block written again, or kept, there changes
 * what the comment further down is. These blocks go after (and before) a note of the corpus, which is
 * then edited in a paragraph of its own, far from them.
 */
export const DISTANT_BLOCKS = [
  '%%\nc\n%%\n',
  '%%cc%% text\n',
  '%% c %%\n    code\n',
  '- %% c %%\ntext\n',
  '> %% c %%\ntext\n',
  'x \\\\^[a] y\n',
  '- a\n\n%% c %%\n  b\n',
  '- b\n\n%% c %%\n\n* d\n',
  '1. z\n\n%%cc%% text\n',
];

/**
 * C1-edit, the edits far from what Reading prepares: a character typed in a paragraph that comes
 * after (or before) every note of `samples` and one of the DISTANT_BLOCKS. The edit path leaves the
 * rest of the note as the file has it, and `forceDirty` writes it again: they must mean the same.
 */
export function measureC1EditDistant(core: LiveCore, samples: Sample[]): C1Edit {
  const res: C1Edit = {
    n: 0,
    refused: 0,
    treeSame: 0,
    extractSame: 0,
    htmlSame: 0,
    same: 0,
    unreadable: 0,
    byOp: {},
    failuresByOp: {},
    failures: [],
  };
  const composer = makeComposer(core);
  const layouts: ((raw: string, far: string) => string)[] = [
    (raw, far) => raw.replace(/\n*$/, '\n') + '\nm\n\n' + far,
    (raw, far) => 'm\n\n' + raw.replace(/\n*$/, '\n') + '\n' + far,
  ];
  for (const sample of samples) {
    if (sample.id.includes('~')) continue; // the CRLF and BOM variants are the same notes
    for (const far of DISTANT_BLOCKS) {
      for (const layout of layouts) {
        const r = LiveSession.open(core, layout(sample.raw, far), composer);
        if (!r.ok) continue;
        const { session } = r;
        let at = -1;
        session.doc.descendants((n, pos) => {
          if (at < 0 && n.isText && n.text === 'm') at = pos + 1;
          return true;
        });
        if (at < 0) continue;
        const doc = EditorState.create({ doc: session.doc }).tr.insertText('y', at).doc;
        compareEdit(core, res, sample, session, 'distant', doc);
      }
    }
  }
  return res;
}

/** The two measurements of C1-edit as one. */
function mergeC1Edit(a: C1Edit, b: C1Edit): C1Edit {
  const sum = (x: Record<string, number>, y: Record<string, number>): Record<string, number> => {
    const out = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  return {
    n: a.n + b.n,
    refused: a.refused + b.refused,
    treeSame: a.treeSame + b.treeSame,
    extractSame: a.extractSame + b.extractSame,
    htmlSame: a.htmlSame + b.htmlSame,
    same: a.same + b.same,
    unreadable: a.unreadable + b.unreadable,
    byOp: sum(a.byOp, b.byOp),
    failuresByOp: sum(a.failuresByOp, b.failuresByOp),
    failures: [...a.failures, ...b.failures],
  };
}

// ------------------------------------------------------------------------------------- raw share

export interface RawShare {
  /** Files that opened, blocks of the document at every level (leaf blocks), and how many are raw. */
  files: number;
  blocks: number;
  rawBlocks: number;
  rawInlines: number;
  /** The raw blocks by what they hold. */
  byKind: Record<string, number>;
}

/** What a raw block holds, in a few words (to group them). */
export function rawKind(raw: string): string {
  const first = raw.split('\n', 1)[0] ?? '';
  if (/^ {0,3}\[\^[^\]]+\]:/.test(first)) return 'footnote definition';
  if (/^ {0,3}\[[^\]]+\]:/.test(first)) return 'link definition';
  if (/^ {0,3}</.test(first)) return 'html';
  if (/%%|\$\$/.test(raw)) return 'multi-line comment or math';
  if (/^ {4}|^\t/.test(first)) return 'indented code';
  if (/\n {0,3}(=+|-+)[ \t]*$/.test(raw)) return 'setext heading';
  if (/^\|/.test(first)) return 'table';
  return 'other';
}

/** How much of the files the editor holds as raw (not edited in place): the cost of the layer. */
export function measureRaw(opened: OpenResult[]): RawShare {
  const res: RawShare = { files: 0, blocks: 0, rawBlocks: 0, rawInlines: 0, byKind: {} };
  for (const { session } of opened) {
    if (!session) continue;
    res.files++;
    session.doc.descendants((node) => {
      if (node.type.name === 'raw_inline') res.rawInlines++;
      if (node.type.name === 'raw_block') {
        res.rawBlocks++;
        res.blocks++;
        const k = rawKind(String(node.attrs['raw']));
        res.byKind[k] = (res.byKind[k] ?? 0) + 1;
      } else if (node.isTextblock || node.type.name === 'hr' || node.type.name === 'image-block') {
        res.blocks++;
      }
      return true;
    });
  }
  return res;
}

// ------------------------------------------------------------------------------------- the gate

export interface Gate {
  corpus: { files: number; nonAdversarial: Record<Criterion, number>; excluded: string[] };
  c1: { all: C1; nonAdversarial: C1 };
  c1edit: C1Edit;
  c2: { all: C2; nonAdversarial: C2; tick: Record<string, number> };
  c3: { all: C3; nonAdversarial: C3 };
  c4: { all: C4; nonAdversarial: C4 };
  raw: Record<string, RawShare>;
}

/** A nested list of `n` tasks: one root item with `n` children. */
export function nestedTasks(n: number): string {
  return (
    '- [ ] root\n' + Array.from({ length: n }, (_, i) => `  - [ ] item ${i + 1}`).join('\n') + '\n'
  );
}

/** Every measurement of the A gate, on the corpus of `samples` (the whole one by default). */
export function runGate(core: LiveCore, samples: Sample[] = fullCorpus()): Gate {
  const non = (c: Criterion): Sample[] => nonAdversarial(samples, c);
  const tick: Record<string, number> = {};
  for (const which of ['first', 'middle', 'last'] as const)
    tick[which] = tickTask(core, nestedTasks(200), which);
  return {
    corpus: {
      files: samples.length,
      nonAdversarial: {
        C1: non('C1').length,
        'C1-edit': non('C1-edit').length,
        C2: non('C2').length,
        C3: non('C3').length,
        C4: non('C4').length,
      },
      excluded: ADVERSARIAL.map((e) => `${e.id} [${e.criteria.join(',')}]`),
    },
    c1: {
      all: measureC1(openAll(core, samples)),
      nonAdversarial: measureC1(openAll(core, non('C1'))),
    },
    c1edit: mergeC1Edit(
      measureC1Edit(core, openAll(core, non('C1-edit'))),
      measureC1EditDistant(core, non('C1-edit')),
    ),
    c2: {
      all: measureC2Insert(openAll(core, samples)),
      nonAdversarial: measureC2Insert(openAll(core, non('C2'))),
      tick,
    },
    c3: { all: measureC3(core, samples), nonAdversarial: measureC3(core, non('C3')) },
    c4: { all: measureC4(core, samples), nonAdversarial: measureC4(core, non('C4')) },
    raw: Object.fromEntries(
      ['conformance', 'demo', 'case'].map((g) => [
        g,
        measureRaw(
          openAll(
            core,
            samples.filter((s) => s.group === g),
          ),
        ),
      ]),
    ),
  };
}

/** The gate as the lines a person reads. */
export function formatGate(g: Gate): string {
  const pct = (a: number, b: number): string =>
    b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(2)}%`;
  const group = (fs: Failure[]): string => {
    const by: Record<string, string[]> = {};
    for (const f of fs) (by[f.cause] ??= []).push(f.id);
    return Object.entries(by)
      .map(
        ([c, ids]) =>
          `${c}: ${ids.length} (${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', ...' : ''})`,
      )
      .join('; ');
  };
  const lines: string[] = [];
  lines.push(
    `corpus: ${g.corpus.files} files; non adversarial C1 ${g.corpus.nonAdversarial.C1}, C1-edit ${g.corpus.nonAdversarial['C1-edit']}, C2 ${g.corpus.nonAdversarial.C2}, C3 ${g.corpus.nonAdversarial.C3}, C4 ${g.corpus.nonAdversarial.C4}`,
  );
  lines.push(`excluded: ${g.corpus.excluded.join(' ')}`);
  for (const [name, c] of [
    ['whole corpus', g.c1.all],
    ['non adversarial', g.c1.nonAdversarial],
  ] as const) {
    lines.push(
      `C1 ${name}: extract ${c.extractSame}/${c.n} (${pct(c.extractSame, c.n)}), HTML ${c.htmlSame}/${c.n} (${pct(c.htmlSame, c.n)}), both ${c.bothSame}/${c.n}, refused ${c.refused}, strict extract ${c.extractStrict}, strict HTML ${c.htmlStrict}, CRLF kept ${c.eolKept}`,
    );
    if (c.failures.length) lines.push(`   failures: ${group(c.failures)}`);
  }
  {
    const c = g.c1edit;
    lines.push(
      `C1-edit (the edit path against forceDirty, positions left out): ${c.same}/${c.n} (${pct(c.same, c.n)}) same tree, extract and HTML; tree ${c.treeSame}, extract ${c.extractSame}, HTML ${c.htmlSame}; refused files ${c.refused}; unreadable by the dev parser ${c.unreadable}; by operation ${JSON.stringify(c.byOp)}; different ${JSON.stringify(c.failuresByOp)}`,
    );
    if (c.failures.length) lines.push(`   failures: ${group(c.failures)}`);
  }
  for (const [name, c] of [
    ['whole corpus', g.c2.all],
    ['non adversarial', g.c2.nonAdversarial],
  ] as const) {
    lines.push(
      `C2 ${name}: <= 1 line in ${c.le1}/${c.n} (${c.pct}%), buckets ${JSON.stringify(c.buckets)}`,
    );
    if (c.failures.length) lines.push(`   failures: ${group(c.failures)}`);
  }
  lines.push(`C2 task of a nested list of 200 items, lines changed: ${JSON.stringify(g.c2.tick)}`);
  for (const [name, c] of [
    ['whole corpus', g.c3.all],
    ['non adversarial', g.c3.nonAdversarial],
  ] as const) {
    lines.push(`C3 ${name}: idempotent ${c.idempotent}/${c.n} (${pct(c.idempotent, c.n)})`);
    if (c.failures.length) lines.push(`   failures: ${group(c.failures)}`);
  }
  for (const [name, c] of [
    ['whole corpus', g.c4.all],
    ['non adversarial', g.c4.nonAdversarial],
  ] as const) {
    lines.push(
      `C4 ${name}: ${c.n} files, dirty on load ${c.notIdentity}, by selection ${c.changedBySelection}, by hover ${c.changedByHover}, text changed ${c.dirtyAtEnd}, refused ${c.refused}`,
    );
  }
  for (const [name, r] of Object.entries(g.raw)) {
    lines.push(
      `raw ${name}: ${r.rawBlocks}/${r.blocks} blocks (${pct(r.rawBlocks, r.blocks)}) in ${r.files} files, ${r.rawInlines} inline; ${JSON.stringify(r.byKind)}`,
    );
  }
  return lines.join('\n');
}

export { captureErrors };
export type { Composer };
export { splitEnvelope };
