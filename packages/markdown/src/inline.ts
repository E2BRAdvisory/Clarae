// The inline Obsidian-flavoured rules in ONE place: `scanInline` finds every OFM construct of a
// source line (wikilinks, embeds, links, tags, ^block ids, ==highlights==, $math$, footnotes,
// %%comments%%, tasks) as typed spans, with the SAME rules as the Go indexer (apps/desktop/
// internal/parser; shared fixtures in shared/conformance/markdown). The indexer (extract.ts) is
// built on top of it, and so can be any other consumer (editors, renderers) that needs to agree
// with the index on what is a link, a tag or a comment.
//
// Offsets are UTF-16 code units, relative to the start of the line. Spans are sorted by `from`
// and MAY overlap: a ==highlight== can contain a wikilink, a task spans its marker only.

/** True for URLs (https://…, mailto:…); one-letter schemes are drive letters. */
export function isExternal(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]+:/.test(target);
}

/** Obsidian rule: a tag needs at least one character that is not a digit, '/', '-' or '_'. */
export function isValidTag(name: string): boolean {
  if (name === '') return false;
  for (const ch of name) {
    if (!/\p{Nd}/u.test(ch) && ch !== '/' && ch !== '-' && ch !== '_') return true;
  }
  return false;
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

const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const TAG = /(^|[ \t\n\f\r([{,;])#([\p{L}\p{N}_\-/]+)/gu;
const BLOCK_ID = /[ \t\n\f\r]\^([A-Za-z0-9-]+)[ \t\n\f\r]*$/;
// `[^\n]` and not `.`: in Go (RE2) a dot matches everything but "\n", so a CR (CRLF files) or U+2028
// does not end the text of a task; in JavaScript a dot stops at those, and the task would be lost.
const TASK =
  /^[ \t\n\f\r]*(?:>[ \t\n\f\r]*)*(?:[-*+]|\d+[.)])[ \t\n\f\r]+\[([^\n])\][ \t\n\f\r]*([^\n]*)$/u;
const FOOTNOTE = /^\[\^([^\]]+)\]:/;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>)]+/g;

// Exported WITHOUT the g flag, so they hold no state (lastIndex): a consumer that iterates builds
// its own global copy (`new RegExp(RE.source, 'g')`, which is also what matchAll does).

/** ==highlight==: no space next to the delimiters. */
export const HIGHLIGHT = /==(?=\S)([^\n]+?)(?<=\S)==/;
/** $inline math$: not $$, no space inside the delimiters, not a price ($5). */
export const INLINE_MATH = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/;
/** [^label] footnote reference (a definition `[^label]:` does not match). */
export const FOOTREF = /\[\^[^\]\s]+\](?!:)/;

// Global variants (some with match indices) for the scanner; matchAll clones them, so they are
// never mutated.
const WIKILINK_D = new RegExp(WIKILINK.source, 'dg');
const MD_LINK_D = new RegExp(MD_LINK.source, 'dg');
const HIGHLIGHT_G = new RegExp(HIGHLIGHT.source, 'g');
const INLINE_MATH_G = new RegExp(INLINE_MATH.source, 'g');
const FOOTREF_G = new RegExp(FOOTREF.source, 'g');
const TASK_D = new RegExp(TASK.source, 'du');

/** Parses a callout title line (after the quote marker): [!type]± title */
export const CALLOUT_RE = /^(\s*>+\s*)\[!([A-Za-z0-9_-]+)\]([+-]?)[ \t]*(.*)$/;

export interface CalloutHead {
  /** Characters before "[!" (the quote marker and spaces). */
  prefixLength: number;
  type: string;
  /** "+" (open by default), "-" (folded by default) or "" (not foldable). */
  marker: string;
  title: string;
}

export function parseCalloutHead(line: string): CalloutHead | null {
  const m = CALLOUT_RE.exec(line);
  if (!m) return null;
  return {
    prefixLength: (m[1] ?? '').length,
    type: (m[2] ?? '').toLowerCase(),
    marker: m[3] ?? '',
    title: (m[4] ?? '').trim(),
  };
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

/** [[target#heading|alias]] and ![[embed|300x200]]. */
export interface WikilinkSpan {
  kind: 'wikilink';
  /** The whole token, including a leading "!". */
  from: number;
  to: number;
  embed: boolean;
  target: string;
  heading: string;
  block: string;
  /** Display text, or the size/alignment of an embed (see embedOptions in the workbench). */
  alias: string;
  /** Between the double brackets. */
  innerFrom: number;
  innerTo: number;
  /** Just the target path (trimmed, before any "#" or "|"). */
  targetFrom: number;
  targetTo: number;
  /** Where the alias starts (just after the "|"); null without a bar. */
  aliasFrom: number | null;
}

/** [text](target) and ![alt](target). */
export interface LinkSpan {
  kind: 'link';
  from: number;
  to: number;
  linkKind: 'markdown' | 'external';
  embed: boolean;
  /** The text between the brackets (wikilinks inside it are blanked, as the indexer sees it). */
  text: string;
  target: string;
  /** Just the target path (before any "#" fragment). */
  targetFrom: number;
  targetTo: number;
}

/** #tag (only valid tags: see isValidTag). `from` is the "#". */
export interface TagSpan {
  kind: 'tag';
  from: number;
  to: number;
  name: string;
}

/** A trailing " ^block-id". `from` is the "^". */
export interface BlockIdSpan {
  kind: 'blockId';
  from: number;
  to: number;
  id: string;
}

/** ==highlight==, delimiters included. */
export interface HighlightSpan {
  kind: 'highlight';
  from: number;
  to: number;
  text: string;
}

/** $inline math$, delimiters included. */
export interface InlineMathSpan {
  kind: 'inlineMath';
  from: number;
  to: number;
  tex: string;
}

/** [^label] */
export interface FootnoteRefSpan {
  kind: 'footnoteRef';
  from: number;
  to: number;
  label: string;
}

/** ^[inline footnote], nested brackets allowed. */
export interface FootnoteInlineSpan {
  kind: 'footnoteInline';
  from: number;
  to: number;
}

/** [^label]: at the start of a line (the marker only). */
export interface FootnoteDefSpan {
  kind: 'footnoteDef';
  from: number;
  to: number;
  label: string;
}

/** A task list item; the span is its "[x]" marker. */
export interface TaskSpan {
  kind: 'task';
  from: number;
  to: number;
  /** The character between the brackets (" ", "x", …). */
  state: string;
  text: string;
}

export type InlineSpan =
  | BlockSpan
  | WikilinkSpan
  | LinkSpan
  | TagSpan
  | BlockIdSpan
  | HighlightSpan
  | InlineMathSpan
  | FootnoteRefSpan
  | FootnoteInlineSpan
  | FootnoteDefSpan
  | TaskSpan;

function wikiTargetSpan(clean: string, from: number, to: number): [number, number] {
  let end = to;
  const m = /[|#]/.exec(clean.slice(from, to));
  if (m) end = from + m.index;
  let start = from;
  while (start < end && (clean[start] === ' ' || clean[start] === '\t')) start++;
  while (end > start && (clean[end - 1] === ' ' || clean[end - 1] === '\t')) end--;
  return [start, end];
}

/**
 * Ranges of the inline footnotes ^[…] of a line whose code spans, comments and math are blanked.
 * The brackets may nest (^[see [[Note]]]); an escaped \^[ and an unclosed one do not count.
 */
function inlineFootnoteRanges(clean: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < clean.length; i++) {
    if (clean[i] !== '^' || clean[i + 1] !== '[' || (i > 0 && clean[i - 1] === '\\')) continue;
    let depth = 0;
    for (let j = i + 1; j < clean.length; j++) {
      if (clean[j] === '[') depth++;
      else if (clean[j] === ']') depth--;
      if (depth === 0) {
        out.push([i, j + 1]);
        i = j;
        break;
      }
    }
  }
  return out;
}

/**
 * Counts the inline footnotes ^[…] of a line whose code spans, comments and math are blanked.
 * Inline footnotes have no label: the index names them ^1, ^2, … in document order, as they are
 * numbered. Same algorithm as the Go parser (shared conformance fixtures).
 */
export function inlineFootnotes(clean: string): number {
  return inlineFootnoteRanges(clean).length;
}

/**
 * All the OFM constructs of one source line, as typed spans sorted by `from`, updating the state
 * that carries to the next line (%%comment%% and $$math$$ blocks).
 *
 * Fenced and indented code blocks are NOT recognised here: the caller decides which lines are
 * code (the indexer takes them from the Markdown tree, the editor from its syntax tree) and does
 * not scan them. Only `inline code` is skipped. On the lines it is given, the same rules as the
 * indexer apply: nothing inside `code`, comments or math; `\[[x]]` is not a link; a tag needs a
 * boundary before the "#" (`**a**#b` has none) and is not looked for inside URLs and Markdown
 * links; a ^block-id is only the last thing of the line. Tasks, footnote definitions and inline
 * footnotes are not reported on lines that continue a comment or a math block.
 */
export function scanInline(line: string, state: BlockState): InlineSpan[] {
  const startedHidden = state.inMath || state.inComment;
  const spans: InlineSpan[] = [];
  const clean = stripInlineCode(line);
  let visible = clean;
  for (const sp of scanSpans(clean, state)) {
    spans.push(sp);
    visible = visible.slice(0, sp.from) + ' '.repeat(sp.to - sp.from) + visible.slice(sp.to);
  }

  for (const m of visible.matchAll(WIKILINK_D)) {
    const idx = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
    const [m0, m1] = idx[0] as [number, number];
    const [bang0, bang1] = idx[1] as [number, number];
    const [in0, in1] = idx[2] as [number, number];
    if (m0 > 0 && visible[m0 - 1] === '\\') continue; // escaped: \[[not a link]]
    const p = parseWikilinkInner(visible.slice(in0, in1));
    const [targetFrom, targetTo] = wikiTargetSpan(visible, in0, in1);
    const bar = visible.indexOf('|', in0);
    const embed = bang1 > bang0;
    spans.push({
      kind: 'wikilink',
      from: m0,
      to: m1,
      embed,
      ...p,
      innerFrom: in0,
      innerTo: in1,
      targetFrom,
      targetTo,
      aliasFrom: bar >= 0 && bar < in1 ? bar + 1 : null,
    });
  }

  // Everything below must not see wikilinks.
  const noWiki = visible.replace(new RegExp(WIKILINK.source, 'g'), (s) => ' '.repeat(s.length));
  for (const m of noWiki.matchAll(MD_LINK_D)) {
    const idx = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
    const [m0, m1] = idx[0] as [number, number];
    const [bang0, bang1] = idx[1] as [number, number];
    const [a0, a1] = idx[2] as [number, number];
    const [t0, t1] = idx[3] as [number, number];
    const target = noWiki.slice(t0, t1);
    const hash = target.indexOf('#');
    spans.push({
      kind: 'link',
      from: m0,
      to: m1,
      linkKind: isExternal(target) ? 'external' : 'markdown',
      embed: bang1 > bang0,
      text: noWiki.slice(a0, a1),
      target,
      targetFrom: t0,
      targetTo: hash >= 0 ? t0 + hash : t1,
    });
  }

  if (noWiki.includes('==')) {
    for (const m of noWiki.matchAll(HIGHLIGHT_G)) {
      const from = m.index ?? 0;
      spans.push({ kind: 'highlight', from, to: from + m[0].length, text: m[1] ?? '' });
    }
  }
  if (noWiki.includes('$')) {
    for (const m of noWiki.matchAll(INLINE_MATH_G)) {
      const from = m.index ?? 0;
      spans.push({ kind: 'inlineMath', from, to: from + m[0].length, tex: m[1] ?? '' });
    }
  }
  if (noWiki.includes('[^')) {
    for (const m of noWiki.matchAll(FOOTREF_G)) {
      const from = m.index ?? 0;
      spans.push({
        kind: 'footnoteRef',
        from,
        to: from + m[0].length,
        label: m[0].slice(2, -1),
      });
    }
  }

  // Blanked column for column (the tag offsets stay true); a boundary is a boundary at any length.
  const noUrl = noWiki
    .replace(new RegExp(URL_RE.source, 'g'), (s) => ' '.repeat(s.length))
    .replace(new RegExp(MD_LINK.source, 'g'), (s) => ' '.repeat(s.length));
  if (noUrl.includes('#')) {
    for (const m of noUrl.matchAll(new RegExp(TAG.source, TAG.flags))) {
      const name = m[2] ?? '';
      if (!isValidTag(name)) continue;
      const from = (m.index ?? 0) + (m[1] ?? '').length;
      spans.push({ kind: 'tag', from, to: from + 1 + name.length, name });
    }
  }
  const b = BLOCK_ID.exec(visible);
  if (b) {
    const id = b[1] ?? '';
    const from = (b.index ?? 0) + 1;
    spans.push({ kind: 'blockId', from, to: from + 1 + id.length, id });
  }

  if (!startedHidden) {
    // Tasks and footnote definitions read the raw line, as the indexer does.
    const t = TASK_D.exec(line);
    if (t) {
      const [s0, s1] = (t as RegExpExecArray & { indices: [number, number][] }).indices[1] as [
        number,
        number,
      ];
      spans.push({
        kind: 'task',
        from: s0 - 1,
        to: s1 + 1,
        state: t[1] ?? '',
        text: (t[2] ?? '').trim(),
      });
    }
    const f = FOOTNOTE.exec(line);
    if (f) spans.push({ kind: 'footnoteDef', from: 0, to: f[0].length, label: f[1] ?? '' });
    if (visible.includes('^[')) {
      for (const [from, to] of inlineFootnoteRanges(visible)) {
        spans.push({ kind: 'footnoteInline', from, to });
      }
    }
  }

  return spans.sort((x, y) => x.from - y.from); // stable
}
