// TypeScript port of apps/desktop/internal/parser: extracts the structure of a
// note (headings, links, tags, tasks, block ids, footnotes, properties, word
// count) with the SAME algorithm as the Go indexer, so the editor, outline and
// status bar agree with the index. Both are verified against the shared
// fixtures in shared/conformance/markdown.
//
// Block structure (headings, code blocks) comes from an mdast tree; inline
// OFM elements are found by scanning source lines outside code, exactly like
// the Go parser. Offsets are UTF-16 code units (what CodeMirror uses).
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Code, Heading as MdHeading, Root } from 'mdast';
import { parse as parseYaml } from 'yaml';

export type LinkKind = 'wikilink' | 'markdown' | 'external';

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface Link {
  line: number;
  kind: LinkKind;
  target: string;
  heading: string;
  block: string;
  alias: string;
  embed: boolean;
  /** Offsets of the whole link token (including a leading "!"). */
  start: number;
  end: number;
  /** Offsets of just the target path (before any "#" fragment). */
  targetStart: number;
  targetEnd: number;
}

export interface Tag {
  line: number;
  name: string;
}
export interface BlockId {
  line: number;
  id: string;
}
export interface Task {
  line: number;
  state: string;
  text: string;
}

export interface NoteDocument {
  title: string;
  aliases: string[];
  properties: Record<string, unknown>;
  headings: Heading[];
  links: Link[];
  tags: Tag[];
  blockIds: BlockId[];
  tasks: Task[];
  footnotes: string[];
  wordCount: number;
  /** Number of file lines taken by the frontmatter block (0 = none). */
  frontmatterLines: number;
}

const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const TAG = /(^|[ \t\n\f\r([{,;])#([\p{L}\p{N}_\-/]+)/gu;
const BLOCK_ID = /[ \t\n\f\r]\^([A-Za-z0-9-]+)[ \t\n\f\r]*$/;
const TASK =
  /^[ \t\n\f\r]*(?:>[ \t\n\f\r]*)*(?:[-*+]|\d+[.)])[ \t\n\f\r]+\[(.)\][ \t\n\f\r]*(.*)$/u;
const FOOTNOTE = /^\[\^([^\]]+)\]:/;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>)]+/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Splits a leading YAML block delimited by "---" lines. */
export function splitFrontmatter(src: string): {
  body: string;
  lines: number;
  yaml: string | null;
} {
  const first = src.indexOf('\n');
  if (first < 0 || src.slice(0, first).replace(/\r+$/, '') !== '---') {
    return { body: src, lines: 0, yaml: null };
  }
  let pos = first + 1;
  let lineNo = 1;
  while (pos <= src.length) {
    const end = src.indexOf('\n', pos);
    const line = end >= 0 ? src.slice(pos, end) : src.slice(pos);
    const next = end >= 0 ? end + 1 : src.length;
    lineNo++;
    const t = line.replace(/\r+$/, '');
    if (t === '---' || t === '...') {
      return { body: src.slice(next), lines: lineNo, yaml: src.slice(first + 1, pos) };
    }
    if (end < 0) break;
    pos = next;
  }
  return { body: src, lines: 0, yaml: null };
}

/** Obsidian rule: a tag needs at least one character that is not a digit, '/', '-' or '_'. */
export function isValidTag(name: string): boolean {
  if (name === '') return false;
  for (const ch of name) {
    if (!/\p{Nd}/u.test(ch) && ch !== '/' && ch !== '-' && ch !== '_') return true;
  }
  return false;
}

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(/[,\s]+/u).filter(Boolean);
  if (Array.isArray(v)) return v.filter((e): e is string => typeof e === 'string');
  return [];
}

function frontmatterKeyLine(fm: string, key: string): number {
  const lines = fm.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trimStart().startsWith(key + ':')) return i + 2;
  }
  return 1;
}

/** YAML values as the index sees them: dates become "YYYY-MM-DD" strings. */
function normalizeYaml(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(normalizeYaml);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeYaml(x)]));
  }
  return v;
}

/** Parses only the frontmatter properties (without tags/aliases/cssclasses). */
export function parseProperties(src: string): Record<string, unknown> {
  const doc = emptyDoc('');
  applyFrontmatter(doc, splitFrontmatter(src).yaml);
  return doc.properties;
}

function emptyDoc(title: string): NoteDocument {
  return {
    title,
    aliases: [],
    properties: {},
    headings: [],
    links: [],
    tags: [],
    blockIds: [],
    tasks: [],
    footnotes: [],
    wordCount: 0,
    frontmatterLines: 0,
  };
}

function applyFrontmatter(doc: NoteDocument, fm: string | null): void {
  if (fm === null) return;
  let data: unknown;
  try {
    data = parseYaml(fm, { schema: 'core' });
  } catch {
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    switch (k) {
      case 'tags':
        for (const tag of stringList(v)) {
          const name = tag.replace(/^#/, '');
          if (isValidTag(name)) doc.tags.push({ line: frontmatterKeyLine(fm, 'tags'), name });
        }
        break;
      case 'aliases':
        doc.aliases.push(...stringList(v));
        break;
      case 'cssclasses':
      case 'cssclass':
        break; // ignored by design (D-01)
      default:
        doc.properties[k] = normalizeYaml(v);
    }
  }
}

/** Blanks `` `code` `` spans keeping every column. */
export function stripInlineCode(s: string): string {
  let out = '';
  let inCode = false;
  for (const ch of s) {
    if (ch === '`') {
      inCode = !inCode;
      out += ' ';
    } else {
      out += inCode ? ' '.repeat(ch.length) : ch;
    }
  }
  return out;
}

/** True for URLs (https://…, mailto:…); one-letter schemes are drive letters. */
export function isExternal(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(target);
}

export interface BlockState {
  inMath: boolean;
  inComment: boolean;
}

export interface BlockSpan {
  kind: 'comment' | 'math';
  /** Offsets within the line; the delimiters themselves are included. */
  from: number;
  to: number;
  /** True when the span starts before this line (it continues a block). */
  continued: boolean;
  /** True when the span is closed on this line (false = runs on to the next line). */
  closed: boolean;
}

/**
 * Finds the %%comment%% and $$math$$ spans of one line, updating the state
 * that carries to the next line. An unclosed block runs to the end of the
 * document. Delimiters belong to the span.
 */
export function scanSpans(s: string, st: BlockState): BlockSpan[] {
  const spans: BlockSpan[] = [];
  let p = 0;
  while (p < s.length) {
    if (st.inComment || st.inMath) {
      const kind = st.inMath ? 'math' : 'comment';
      const delim = st.inMath ? '$$' : '%%';
      const end = s.indexOf(delim, p);
      if (end < 0) {
        spans.push({
          kind,
          from: p,
          to: s.length,
          continued: spans.length === 0 && p === 0,
          closed: false,
        });
        return spans;
      }
      spans.push({
        kind,
        from: p,
        to: end + 2,
        continued: spans.length === 0 && p === 0,
        closed: true,
      });
      p = end + 2;
      st.inComment = false;
      st.inMath = false;
    } else {
      const c = s.indexOf('%%', p);
      const m = s.indexOf('$$', p);
      if (c < 0 && m < 0) return spans;
      const isComment = m < 0 || (c >= 0 && c < m);
      const start = isComment ? c : m;
      const delim = isComment ? '%%' : '$$';
      const end = s.indexOf(delim, start + 2);
      if (end < 0) {
        spans.push({
          kind: isComment ? 'comment' : 'math',
          from: start,
          to: s.length,
          continued: false,
          closed: false,
        });
        if (isComment) st.inComment = true;
        else st.inMath = true;
        return spans;
      }
      spans.push({
        kind: isComment ? 'comment' : 'math',
        from: start,
        to: end + 2,
        continued: false,
        closed: true,
      });
      p = end + 2;
    }
  }
  return spans;
}

/**
 * Blanks (keeping every column) everything inside %%comments%% and $$math$$,
 * updating the state that carries to the next line.
 */
export function maskBlocks(s: string, st: BlockState): string {
  let out = s;
  for (const sp of scanSpans(s, st)) {
    out = out.slice(0, sp.from) + ' '.repeat(sp.to - sp.from) + out.slice(sp.to);
  }
  return out;
}

interface Parsed {
  target: string;
  heading: string;
  block: string;
  alias: string;
}

/** Splits the inside of a wikilink: target#heading|alias or target#^block|alias. */
export function parseWikilinkInner(inner: string): Parsed {
  let target = inner;
  let alias = '';
  const bar = inner.indexOf('|');
  if (bar >= 0) {
    target = inner.slice(0, bar);
    alias = inner.slice(bar + 1);
  }
  let heading = '';
  let block = '';
  const hash = target.indexOf('#');
  if (hash >= 0) {
    const frag = target.slice(hash + 1);
    target = target.slice(0, hash);
    if (frag.startsWith('^')) block = frag.slice(1);
    else heading = frag;
  }
  return { target: target.trim(), heading, block, alias };
}

function wikiTargetSpan(clean: string, from: number, to: number, base: number): [number, number] {
  let end = to;
  const m = /[|#]/.exec(clean.slice(from, to));
  if (m) end = from + m.index;
  let start = from;
  while (start < end && (clean[start] === ' ' || clean[start] === '\t')) start++;
  while (end > start && (clean[end - 1] === ' ' || clean[end - 1] === '\t')) end--;
  return [base + start, base + end];
}

function scanLine(
  doc: NoteDocument,
  line: string,
  clean: string,
  lineNo: number,
  base: number,
  startedHidden: boolean,
): void {
  const found: { col: number; link: Link }[] = [];
  const wikiRe = new RegExp(WIKILINK.source, 'dg');
  for (const m of clean.matchAll(wikiRe)) {
    const idx = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
    const [m0, m1] = idx[0] as [number, number];
    const [bang0, bang1] = idx[1] as [number, number];
    const [in0, in1] = idx[2] as [number, number];
    if (m0 > 0 && clean[m0 - 1] === '\\') continue; // escaped: \[[not a link]]
    const p = parseWikilinkInner(clean.slice(in0, in1));
    const [targetStart, targetEnd] = wikiTargetSpan(clean, in0, in1, base);
    found.push({
      col: m0,
      link: {
        line: lineNo,
        kind: 'wikilink',
        ...p,
        embed: bang1 > bang0,
        start: base + m0,
        end: base + m1,
        targetStart,
        targetEnd,
      },
    });
  }
  // Blank wikilinks keeping columns so Markdown links can be located/ordered.
  const noWiki = clean.replace(new RegExp(WIKILINK.source, 'g'), (m) => ' '.repeat(m.length));
  const mdRe = new RegExp(MD_LINK.source, 'dg');
  for (const m of noWiki.matchAll(mdRe)) {
    const idx = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
    const [m0, m1] = idx[0] as [number, number];
    const [bang0, bang1] = idx[1] as [number, number];
    const [a0, a1] = idx[2] as [number, number];
    const [t0, t1] = idx[3] as [number, number];
    const target = noWiki.slice(t0, t1);
    const kind: LinkKind = isExternal(target) ? 'external' : 'markdown';
    const hash = target.indexOf('#');
    found.push({
      col: m0,
      link: {
        line: lineNo,
        kind,
        target,
        heading: '',
        block: '',
        alias: noWiki.slice(a0, a1),
        embed: bang1 > bang0,
        start: base + m0,
        end: base + m1,
        targetStart: base + t0,
        targetEnd: base + (hash >= 0 ? t0 + hash : t1),
      },
    });
  }
  found.sort((a, b) => a.col - b.col); // stable
  for (const f of found) doc.links.push(f.link);

  const noUrl = noWiki
    .replace(new RegExp(URL_RE.source, 'g'), ' ')
    .replace(new RegExp(MD_LINK.source, 'g'), ' ');
  for (const m of noUrl.matchAll(new RegExp(TAG.source, TAG.flags))) {
    const name = m[2] ?? '';
    if (isValidTag(name)) doc.tags.push({ line: lineNo, name });
  }
  const b = BLOCK_ID.exec(clean);
  if (b) doc.blockIds.push({ line: lineNo, id: b[1] ?? '' });
  if (startedHidden) return;
  const t = TASK.exec(line);
  if (t) doc.tasks.push({ line: lineNo, state: t[1] ?? '', text: (t[2] ?? '').trim() });
  const f = FOOTNOTE.exec(line);
  if (f) doc.footnotes.push(f[1] ?? '');
}

function headingText(node: MdHeading, lines: string[]): string {
  const start = node.position?.start.line ?? 1;
  const end = node.position?.end.line ?? start;
  const raw = lines.slice(start - 1, end);
  const first = raw[0] ?? '';
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(first)) {
    return first
      .replace(/^ {0,3}#{1,6}[ \t]*/, '')
      .replace(/[ \t]+#+[ \t]*$/, '')
      .replace(/^#+[ \t]*$/, '')
      .trim();
  }
  // Setext: every line but the underline.
  return raw.slice(0, -1).join('\n').trim();
}

function countWords(body: string): number {
  let n = 0;
  for (const tok of body.split(/\s+/u)) {
    if (tok && /[\p{L}\p{N}]/u.test(tok)) n++;
  }
  return n;
}

/** Extracts the structure of a note. `title` is the file name without extension. */
export function extract(title: string, src: string): NoteDocument {
  const doc = emptyDoc(title);
  const fm = splitFrontmatter(src);
  doc.frontmatterLines = fm.lines;
  applyFrontmatter(doc, fm.yaml);

  const body = fm.body;
  const lines = body.split('\n');
  const codeLines = new Array<boolean>(lines.length).fill(false);

  const tree: Root = fromMarkdown(body);
  const visit = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'heading') {
      const h = node as MdHeading;
      const text = headingText(h, lines);
      if (text !== '')
        doc.headings.push({ level: h.depth, text, line: (h.position?.start.line ?? 1) + fm.lines });
    } else if (node.type === 'code') {
      const c = node as Code;
      const s = c.position?.start.line ?? 0;
      const e = c.position?.end.line ?? 0;
      for (let l = s; l <= e; l++) if (l >= 1 && l <= codeLines.length) codeLines[l - 1] = true;
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
      codeLines[i] = true;
    } else if (delim.startsWith(fence.charAt(0)) && delim.length >= fence.length) {
      inFence = false;
      codeLines[i] = true;
    }
  });

  const state: BlockState = { inMath: false, inComment: false };
  let lineStart = src.length - body.length;
  lines.forEach((raw, i) => {
    const base = lineStart;
    lineStart += raw.length + 1;
    if (codeLines[i]) return;
    const hidden = state.inMath || state.inComment;
    const visible = maskBlocks(stripInlineCode(raw), state);
    scanLine(doc, raw, visible, i + 1 + fm.lines, base, hidden);
  });
  doc.wordCount = countWords(body);
  return doc;
}
