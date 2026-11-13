// The slides of a presentation as text (ADR-0048): where each one starts and ends, its title, its
// presenter notes, whether it is left out, and the edits the Slideshow tab makes (move, leave out,
// notes, settings). Pure: every edit is a list of source edits against the source it was
// computed from, applied as one transaction, so it is a single undo step. The positions of the
// slides come from the renderer (`Deck.slideLines`): Marp is the authority on what a slide is.
import type { SourceEdit } from '../editor/types';

/** The comment that leaves a slide out of the presentation and of its exports. */
export const HIDDEN_MARKER = '<!-- clarae: hidden -->';
/** A hidden-slide marker as written now or by 1.x (existing markers are never rewritten). */
export const HIDDEN_RE = /^(clarae|memobrain):\s*hidden$/i;

/** A horizontal rule: the separator between two slides. */
const SEPARATOR = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/**
 * Marp's directives, as Marpit and Marp Core define them (a test compares the lists with the
 * engine): a comment with one of these keys is configuration, not a note. `title`, `author`,
 * `transition`, `marp`... are not directives of Marp Core: for it they are notes.
 */
const GLOBAL_DIRECTIVES = new Set(['theme', 'style', 'headingDivider', 'lang', 'size', 'math']);
/** The local ones also exist with a `_` prefix (they apply to one slide only). */
const LOCAL_DIRECTIVES = new Set([
  'class',
  'paginate',
  'header',
  'footer',
  'backgroundColor',
  'backgroundImage',
  'backgroundPosition',
  'backgroundRepeat',
  'backgroundSize',
  'color',
]);
export const DIRECTIVE_KEYS: readonly string[] = [...GLOBAL_DIRECTIVES, ...LOCAL_DIRECTIVES];

/** Comments that tools read (Prettier, markdownlint, remark-lint): Marpit keeps them out of the notes. */
const MAGIC_COMMENTS = [
  /^prettier-ignore(-(start|end))?$/,
  /^markdownlint-((disable|enable).*|capture|restore)$/,
  /^lint (disable|enable|ignore).*$/,
];

const isDirectiveKey = (key: string): boolean =>
  GLOBAL_DIRECTIVES.has(key) ||
  LOCAL_DIRECTIVES.has(key) ||
  (key.startsWith('_') && LOCAL_DIRECTIVES.has(key.slice(1)));

/** The slide that holds a 0-based line of the source. */
export function slideAt(slideLines: readonly number[], line: number): number {
  let i = 0;
  while (i + 1 < slideLines.length && (slideLines[i + 1] ?? Infinity) <= line) i++;
  return i;
}

export interface DeckSlide {
  /** 0-based position. */
  index: number;
  /** First line of the slide (its `---` separator, except for the first slide). */
  start: number;
  /** Last line of the slide. */
  end: number;
  /** First line of its content: after the separator (after the frontmatter, for the first slide). */
  bodyStart: number;
  /** The first heading, else the first line of text; empty when the slide has neither. */
  title: string;
  /** The presenter notes: its comments that are neither directives nor markers. */
  notes: string;
  /** Left out of the presentation. */
  hidden: boolean;
  /** Words of text (code blocks and comments not counted). */
  words: number;
}

interface Comment {
  from: number;
  to: number;
  text: string;
  /** A block of its own (it begins its line, outside any paragraph), not one inside a paragraph. */
  block: boolean;
}

interface Layout {
  /** The lines, without their line break (a `\r` of CRLF included). */
  lines: string[];
  /** Offset of the start of each line. */
  offs: number[];
}

function layoutOf(source: string): Layout {
  const raw = source.split('\n');
  const offs: number[] = [];
  let at = 0;
  for (const l of raw) {
    offs.push(at);
    at += l.length + 1;
  }
  return { lines: raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)), offs };
}

const lineEnd = (lay: Layout, l: number): number =>
  (lay.offs[l] ?? 0) + (lay.lines[l]?.length ?? 0);

/** The line of the closing `---` of the frontmatter, or -1 when the file has none. */
function frontmatterEnd(lines: readonly string[]): number {
  if (!/^---\s*$/.test(lines[0] ?? '')) return -1;
  for (let j = 1; j < lines.length; j++) if (/^(---|\.\.\.)\s*$/.test(lines[j] ?? '')) return j;
  return -1;
}

const stripMarkup = (s: string): string =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[*_`~]/g, '')
    .trim();

const LIST_ITEM = /^( *)(?:[-*+]|\d{1,9}[.)])( +|$)/;

/** Width of the leading whitespace (a tab counts as four columns). */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** Length of the run of backticks that starts at `p`. */
function tickRun(line: string, p: number): number {
  let n = 0;
  while (line[p + n] === '`') n++;
  return n;
}

/** Whether the line ends a paragraph that is open above it (a list item, a heading, a fence...). */
function interruptsParagraph(line: string): boolean {
  if (!line.trim()) return true;
  if (SEPARATOR.test(line) || HEADING.test(line) || FENCE.test(line)) return true;
  const item = LIST_ITEM.exec(line);
  if (!item) return false;
  const marker = line.trimStart();
  return /^[-*+]/.test(marker) ? !!line.slice(item[0].length).trim() : /^1[.)]/.test(marker);
}

/** Whether a run of exactly `n` backticks closes a code span after `p` (same paragraph). */
function spanCloses(lay: Layout, l: number, p: number, n: number, to: number): boolean {
  for (let k = l; k <= to && k < lay.lines.length; k++) {
    const line = lay.lines[k] ?? '';
    if (k > l && interruptsParagraph(line)) return false;
    for (let q = k === l ? p : 0; q < line.length;) {
      if (line[q] === '`') {
        const r = tickRun(line, q);
        if (r === n) return true;
        q += r;
      } else q++;
    }
  }
  return false;
}

/**
 * What a slide holds: comments (with their place in the source) and the text outside them. It reads
 * comments as Marpit does: on a line of their own they are blocks (up to the line with the `-->`),
 * inside a paragraph they are inline; never inside fenced or indented code or inside a code span.
 */
function scan(source: string, lay: Layout, from: number, to: number) {
  const comments: Comment[] = [];
  const text: string[] = [];
  let fence = '';
  let open = -1; // offset of the `<!--` of a comment that is still open
  let block = false; // the open comment is a block (it swallows the rest of its last line)
  let span = 0; // length of the backtick run of the code span that is still open
  let prevBlank = true;
  let inCode = false; // the previous lines are an indented code block
  let listAt = 0; // content column of the list item we are in (0 when none)
  let para = false; // the previous line is a paragraph that is still open: a block cannot start
  const push = (c: Omit<Comment, 'block'>): void => {
    comments.push({ ...c, block, text: c.text.replace(/^-+/, '').replace(/-+$/, '') });
  };
  for (let l = from; l <= to && l < lay.lines.length; l++) {
    const line = lay.lines[l] ?? '';
    const base = lay.offs[l] ?? 0;
    const blank = !line.trim();
    if (open >= 0 && !block && blank) open = -1; // a paragraph ends: an inline comment cannot span it
    if (open < 0 && span === 0) {
      const f = FENCE.exec(line);
      if (fence) {
        // The closing line carries no info string: ```js inside ```md does not close it.
        if (
          f &&
          (f[1] as string)[0] === fence[0] &&
          (f[1] as string).length >= fence.length &&
          !line.slice(f[0].length).trim()
        )
          fence = '';
        para = false;
        continue;
      }
      if (f) {
        fence = f[1] as string;
        prevBlank = false;
        inCode = false;
        para = false;
        continue;
      }
      if (blank) {
        prevBlank = true;
        para = false;
        continue;
      }
      if (listAt > 0 && indentOf(line) < listAt && !LIST_ITEM.test(line)) listAt = 0;
      if (indentOf(line) - listAt >= 4 && (prevBlank || inCode)) {
        inCode = true;
        prevBlank = false;
        para = false;
        continue;
      }
      inCode = false;
      const item = LIST_ITEM.exec(line);
      if (item && !SEPARATOR.test(line)) {
        const gap = (item[2] as string).length;
        listAt = item[0].length - gap + (gap >= 1 && gap <= 4 ? gap : 1);
      }
    }
    prevBlank = false;
    let visible = '';
    let p = 0;
    // A comment that begins its line (indent below four) is a block, unless a paragraph is open
    // above it: a block comment cannot interrupt one (the comment is then inline).
    let blockLine = false;
    if (
      open < 0 &&
      span === 0 &&
      !para &&
      indentOf(line) < 4 &&
      line.trimStart().startsWith('<!--')
    ) {
      blockLine = true;
      const s = line.indexOf('<!--');
      open = base + s;
      block = true;
      p = s + 4;
      const e = line.indexOf('-->', s);
      if (e >= 0) {
        push({ from: open, to: base + e + 3, text: source.slice(open + 4, base + e) });
        open = -1;
        block = false;
        p = line.length + 1; // the rest of the line is part of the block
      }
    }
    while (p <= line.length) {
      if (open >= 0) {
        const e = line.indexOf('-->', p);
        if (e < 0) break;
        const end = base + e + 3;
        push({ from: open, to: end, text: source.slice(open + 4, end - 3) });
        open = -1;
        p = block ? line.length + 1 : e + 3;
        block = false;
      } else if (span > 0) {
        const q = line.indexOf('`', p);
        if (q < 0) {
          visible += line.slice(p);
          break;
        }
        const r = tickRun(line, q);
        visible += line.slice(p, q + r);
        p = q + r;
        if (r === span) span = 0;
      } else {
        let q = p;
        while (q < line.length) {
          const ch = line[q];
          if (ch === '\\') q += 2;
          else if (ch === '`' || (ch === '<' && line.startsWith('<!--', q))) break;
          else q++;
        }
        if (q >= line.length) {
          visible += line.slice(p);
          break;
        }
        visible += line.slice(p, q);
        if (line[q] === '`') {
          const r = tickRun(line, q);
          visible += line.slice(q, q + r);
          p = q + r;
          if (spanCloses(lay, l, p, r, to)) span = r;
        } else {
          open = base + q;
          block = false;
          p = q + 4;
        }
      }
    }
    if (open < 0 || visible.trim()) text.push(visible);
    // Where the next line stands: after a heading, a rule or a whole block comment nothing is open.
    para = !(blockLine || HEADING.test(line) || SEPARATOR.test(line));
  }
  return { comments, text };
}

/** A key of a flow mapping (`{theme: gaia, class: lead}`): after the brace or a comma. */
const FLOW_KEY = /([{,]\s*)(["']?)(_?[A-Za-z][\w-]*)(\2\s*:(?=\s|$|[,}]))/g;
const isFlowMapping = (comment: string): boolean => /^\{[\s\S]*\}$/.test(comment.trim());

/** Whether the comment is configuration for Marp: a YAML mapping with at least one directive key. */
function isDirective(comment: string): boolean {
  if (isFlowMapping(comment))
    return [...comment.matchAll(FLOW_KEY)].some((m) => isDirectiveKey(m[3] as string));
  const rows = comment.split('\n').filter((r) => r.trim() && indentOf(r) === 0);
  let known = false;
  for (const r of rows) {
    const m = /^(["']?)(_?[A-Za-z][\w-]*)\1\s*:(?:\s|$)/.exec(r);
    if (!m) return false;
    if (isDirectiveKey(m[2] as string)) known = true;
  }
  return known;
}

const isMarker = (c: Comment): boolean => HIDDEN_RE.test(c.text.trim());
const isNote = (c: Comment): boolean => {
  const t = c.text.trim();
  return !!t && !isMarker(c) && !isDirective(t) && !MAGIC_COMMENTS.some((re) => re.test(t));
};

function titleOf(text: readonly string[]): string {
  for (const row of text) {
    const m = HEADING.exec(row);
    if (m?.[1] !== undefined) {
      const t = stripMarkup(m[1]);
      if (t) return t;
    }
  }
  for (const row of text) {
    if (!row.trim()) continue;
    const t = stripMarkup(row.replace(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)+/, ''));
    if (t) return t;
  }
  return '';
}

function slideBounds(lay: Layout, slideLines: readonly number[]) {
  const fm = frontmatterEnd(lay.lines);
  const starts = slideLines.length > 0 ? [...slideLines] : [0];
  return starts.map((start, i) => {
    const end = (starts[i + 1] ?? lay.lines.length) - 1;
    const isSep = i > 0 && SEPARATOR.test(lay.lines[start] ?? '');
    const bodyStart = i === 0 ? fm + 1 : isSep ? start + 1 : start;
    return { start, end: Math.max(end, start), bodyStart: Math.min(bodyStart, end + 1) };
  });
}

/** The slides of the source; `slideLines` are the 0-based start lines the renderer reports. */
export function deckSlides(source: string, slideLines: readonly number[]): DeckSlide[] {
  const lay = layoutOf(source);
  return slideBounds(lay, slideLines).map((b, index) => {
    const { comments, text } = scan(source, lay, b.bodyStart, b.end);
    return {
      index,
      ...b,
      title: titleOf(text),
      notes: comments
        .filter(isNote)
        .map((c) => c.text.trim())
        .join('\n\n'),
      hidden: comments.some(isMarker),
      words: text
        .map((r) => r.replace(/^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/, ''))
        .join(' ')
        .split(/\s+/)
        .filter(Boolean).length,
    };
  });
}

/** Slides can be moved when they are told apart by `---` lines (not by `headingDivider`). */
export function canReorder(source: string, slideLines: readonly number[]): boolean {
  const { lines } = layoutOf(source);
  return slideLines.slice(1).every((l) => SEPARATOR.test(lines[l] ?? ''));
}

function lineOfOffset(lay: Layout, off: number): number {
  let l = 0;
  while (l + 1 < lay.offs.length && (lay.offs[l + 1] ?? Infinity) <= off) l++;
  return l;
}

/** Deletes a comment; when it fills its lines the lines go with it. */
function removal(lay: Layout, c: Comment): SourceEdit {
  const a = lineOfOffset(lay, c.from);
  const b = lineOfOffset(lay, c.to);
  const fills = c.from === lay.offs[a] && c.to === lineEnd(lay, b);
  if (!fills) return { from: c.from, to: c.to };
  const blank = (l: number): boolean => !(lay.lines[l] ?? '').trim();
  if (b + 1 >= lay.lines.length) {
    // The last line of the file: the line break before it goes, too.
    return a > 0 ? { from: lineEnd(lay, a - 1), to: c.to } : { from: c.from, to: c.to };
  }
  // The lines go; so does the blank line that set a comment apart from the text above it.
  const gap = a > 0 && blank(a - 1) && blank(b + 1);
  return { from: gap ? (lay.offs[a - 1] as number) : c.from, to: lay.offs[b + 1] as number };
}

/** Appends text as a new paragraph at the end of a slide's content. */
function appendToSlide(
  lay: Layout,
  slide: { bodyStart: number; end: number },
  add: string,
): SourceEdit {
  let last = slide.end;
  while (last >= slide.bodyStart && !(lay.lines[last] ?? '').trim()) last--;
  if (last < slide.bodyStart) {
    // An empty slide at the very end (the file stops at its `---`): the text goes after the separator.
    if (slide.bodyStart >= lay.lines.length) {
      const endAt = lineEnd(lay, lay.lines.length - 1);
      return { from: endAt, insert: `\n${add}` };
    }
    return { from: lay.offs[slide.bodyStart] as number, insert: `${add}\n` };
  }
  return { from: lineEnd(lay, last), insert: `\n\n${add}` };
}

/** Keeps a note from being read as a directive: the key of such a line gets an invisible character. */
function neutralize(text: string): string {
  if (!isDirective(text)) return text;
  if (isFlowMapping(text))
    return text.replace(FLOW_KEY, (m, lead: string, q: string, k: string, rest: string) =>
      isDirectiveKey(k) ? `${lead}${q}${k}\u200b${rest}` : m,
    );
  return text
    .split('\n')
    .map((r) =>
      r.replace(/^(["']?)(_?[A-Za-z][\w-]*)(\1\s*:)/, (m, q, k: string, rest: string) =>
        isDirectiveKey(k) ? `${q}${k}\u200b${rest}` : m,
      ),
    )
    .join('\n');
}

/** A note as the panel and the show display it: without the invisible character `neutralize` adds. */
export const displayNote = (text: string): string => text.replace(/\u200b/g, '');

const noteComment = (text: string): string => {
  const t = neutralize(text.trim().replace(/-->/g, '--&gt;'));
  return t.includes('\n') ? `<!--\n${t}\n-->` : `<!-- ${t} -->`;
};

/** Changes that leave a slide out of the presentation, or put it back. */
export function hiddenEdit(
  source: string,
  slideLines: readonly number[],
  index: number,
  hidden: boolean,
): SourceEdit[] {
  const lay = layoutOf(source);
  const b = slideBounds(lay, slideLines)[index];
  if (!b) return [];
  const markers = scan(source, lay, b.bodyStart, b.end).comments.filter(isMarker);
  if (hidden) return markers.length > 0 ? [] : [appendToSlide(lay, b, HIDDEN_MARKER)];
  return markers.map((c) => removal(lay, c));
}

/** Changes that leave several slides out (or put them back), for "include all" / "exclude all". */
export function setHiddenEdit(
  source: string,
  slideLines: readonly number[],
  indices: readonly number[],
  hidden: boolean,
): SourceEdit[] {
  return indices.flatMap((i) => hiddenEdit(source, slideLines, i, hidden));
}

/** Changes that write the presenter notes of a slide (an empty text removes them). */
export function notesEdit(
  source: string,
  slideLines: readonly number[],
  index: number,
  text: string,
): SourceEdit[] {
  const lay = layoutOf(source);
  const b = slideBounds(lay, slideLines)[index];
  if (!b) return [];
  const notes = scan(source, lay, b.bodyStart, b.end).comments.filter(isNote);
  if (!text.trim()) return notes.map((c) => removal(lay, c));
  const [first, ...rest] = notes;
  if (!first) return [appendToSlide(lay, b, noteComment(text))];
  const comment = noteComment(text);
  // A comment of several lines is only safe as a block at column 0: inside a list item, a quote or
  // a paragraph its lines would be read as text of the slide. There the old note goes and the new
  // one is written as a block at the end of the slide.
  const topLevel = first.block && first.from === lay.offs[lineOfOffset(lay, first.from)];
  if (comment.includes('\n') && !topLevel)
    return [...notes.map((c) => removal(lay, c)), appendToSlide(lay, b, comment)];
  return [{ from: first.from, to: first.to, insert: comment }, ...rest.map((c) => removal(lay, c))];
}

/** Changes that swap a slide with the previous (-1) or the next (1) one; none at the ends. */
export function moveSlideEdit(
  source: string,
  slideLines: readonly number[],
  index: number,
  dir: -1 | 1,
): SourceEdit[] {
  const lo = dir < 0 ? index - 1 : index;
  if (lo < 0 || lo + 1 >= slideLines.length || !canReorder(source, slideLines)) return [];
  const lay = layoutOf(source);
  const bounds = slideBounds(lay, slideLines);
  const a = bounds[lo];
  const b = bounds[lo + 1];
  if (!a || !b) return [];
  const split = (arr: string[]) => {
    let s = 0;
    while (s < arr.length && !(arr[s] as string).trim()) s++;
    let e = arr.length;
    while (e > s && !(arr[e - 1] as string).trim()) e--;
    return { lead: arr.slice(0, s), core: arr.slice(s, e), trail: arr.slice(e) };
  };
  const first = split(lay.lines.slice(a.bodyStart, a.end + 1));
  const second = split(lay.lines.slice(b.bodyStart, b.end + 1));
  const insert = [
    ...first.lead,
    ...second.core,
    ...first.trail,
    lay.lines[b.start] as string,
    ...second.lead,
    ...first.core,
    ...second.trail,
  ].join('\n');
  const from =
    a.bodyStart <= a.end ? (lay.offs[a.bodyStart] as number) : (lay.offs[b.start] as number);
  return [{ from, to: lineEnd(lay, b.end), insert }];
}

/** The frontmatter keys of the settings, and the keys 1.x wrote for them (read, never written). */
export const LOOP_KEY = 'clarae-loop';
export const NOTES_KEY = 'clarae-notes';
const LEGACY_KEYS: Readonly<Record<string, readonly string[]>> = {
  [LOOP_KEY]: ['memobrain-loop'],
  [NOTES_KEY]: ['memobrain-notes'],
};

/** The settings the presentation keeps in its frontmatter. */
export interface DeckSettings {
  theme: string;
  paginate: boolean;
  /** `clarae-loop` (1.x: `memobrain-loop`): start again after the last slide. */
  loop: boolean;
  /** `clarae-notes` (1.x: `memobrain-notes`): show the presenter notes (on unless set to false). */
  notes: boolean;
}

/** The frontmatter as key and text of value (quotes removed); empty when there is none. */
export function readFrontmatter(source: string): Record<string, string> {
  const { lines } = layoutOf(source);
  const end = frontmatterEnd(lines);
  const out: Record<string, string> = {};
  for (let l = 1; l < end; l++) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(lines[l] ?? '');
    if (m) out[m[1] as string] = (m[2] as string).replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** A setting of the frontmatter: the current key, else the one of 1.x. */
function setting(fm: Record<string, string>, key: string): string | undefined {
  for (const k of [key, ...(LEGACY_KEYS[key] ?? [])]) if (fm[k] !== undefined) return fm[k];
  return undefined;
}

export function deckSettings(source: string): DeckSettings {
  const fm = readFrontmatter(source);
  return {
    theme: fm['theme'] || 'default',
    paginate: fm['paginate'] === 'true',
    loop: setting(fm, LOOP_KEY) === 'true',
    notes: setting(fm, NOTES_KEY) !== 'false',
  };
}

const yamlValue = (v: string | boolean | number): string =>
  typeof v === 'string' && !/^[\w.-]+$/.test(v) ? JSON.stringify(v) : String(v);

/**
 * Changes that set a frontmatter key (null removes it), creating the frontmatter when needed. A
 * setting that 1.x wrote under its old key moves to the current one in the same edit list: the
 * old line is replaced (or removed), so one undo step restores both.
 */
export function frontmatterEdit(
  source: string,
  key: string,
  value: string | boolean | number | null,
): SourceEdit[] {
  const lay = layoutOf(source);
  const end = frontmatterEnd(lay.lines);
  const row = value === null ? '' : `${key}: ${yamlValue(value)}`;
  if (end < 0) {
    if (value === null) return [];
    return [{ from: 0, insert: `---\nmarp: true\n${row}\n---\n\n` }];
  }
  const linesOf = (k: string): number[] => {
    const re = new RegExp(`^${k.replace(/[-]/g, '\\-')}\\s*:`);
    const out: number[] = [];
    lay.lines.forEach((l, i) => {
      if (i > 0 && i < end && re.test(l)) out.push(i);
    });
    return out;
  };
  const remove = (i: number): SourceEdit => ({
    from: lay.offs[i] as number,
    to: lay.offs[i + 1] as number,
  });
  const at = linesOf(key)[0] ?? -1;
  const legacy = (LEGACY_KEYS[key] ?? []).flatMap(linesOf);
  const edits: SourceEdit[] = [];
  let placed = at >= 0;
  if (at >= 0) {
    edits.push(
      value === null
        ? remove(at)
        : { from: lay.offs[at] as number, to: lineEnd(lay, at), insert: row },
    );
  }
  for (const i of legacy) {
    if (value !== null && !placed) {
      edits.push({ from: lay.offs[i] as number, to: lineEnd(lay, i), insert: row });
      placed = true;
    } else edits.push(remove(i));
  }
  if (!placed && value !== null) edits.push({ from: lay.offs[end] as number, insert: `${row}\n` });
  return edits;
}

/**
 * Numbers the pages of the slides that stay 1..n: the gap a left-out slide leaves in the page
 * numbers Marp wrote (`data-marpit-pagination`, and the total beside it) is closed. Only a left-out
 * slide that moved Marp's counter on leaves a gap (`advances[i]`: not `paginate: skip` or `hold`).
 */
export function renumberPages(
  root: ParentNode,
  hidden: readonly boolean[],
  advances: readonly boolean[] = [],
): void {
  const shift = (el: Element, attr: string, by: number): void => {
    const n = Number(el.getAttribute(attr));
    if (by > 0 && Number.isFinite(n)) el.setAttribute(attr, String(Math.max(1, n - by)));
  };
  let dropped = 0;
  root.querySelectorAll('div.marpit > svg').forEach((svg, i) => {
    if (hidden[i]) dropped += advances[i] === false ? 0 : 1;
    else
      for (const el of svg.querySelectorAll('[data-marpit-pagination]'))
        shift(el, 'data-marpit-pagination', dropped);
  });
  for (const el of root.querySelectorAll('[data-marpit-pagination-total]'))
    shift(el, 'data-marpit-pagination-total', dropped);
}

/**
 * The slides that take part in the presentation and its exports (HTML, PDF, PPTX): the `svg` at each
 * hidden index of `div.marpit > svg` is dropped, together with its notes. `indices` are the positions
 * the kept slides had in the whole presentation.
 */
export function includedDeck(deck: {
  html: string;
  notes: readonly string[];
  hidden: readonly boolean[];
  advances?: readonly boolean[];
}): { html: string; notes: string[]; indices: number[] } {
  const doc = new DOMParser().parseFromString(`<body>${deck.html}</body>`, 'text/html');
  const svgs = [...doc.querySelectorAll('div.marpit > svg')];
  const indices: number[] = [];
  renumberPages(doc.body, deck.hidden, deck.advances);
  svgs.forEach((svg, i) => {
    if (deck.hidden[i]) svg.remove();
    else indices.push(i);
  });
  return { html: doc.body.innerHTML, notes: indices.map((i) => deck.notes[i] ?? ''), indices };
}
