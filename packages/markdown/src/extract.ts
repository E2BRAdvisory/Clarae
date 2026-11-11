// TypeScript port of apps/desktop/internal/parser: extracts the structure of a
// note (headings, links, tags, tasks, block ids, footnotes, properties, word
// count) with the SAME algorithm as the Go indexer, so the editor, outline and
// status bar agree with the index. Both are verified against the shared
// fixtures in shared/conformance/markdown.
//
// Block structure (headings, code blocks) comes from an mdast tree; inline
// OFM elements are found by scanning source lines outside code, exactly like
// the Go parser. Offsets are UTF-16 code units (what CodeMirror uses).
import type { Heading as MdHeading } from 'mdast';
import { parse as parseYaml } from 'yaml';
import { scanBody } from './body';
import { isValidTag, type InlineSpan } from './inline';

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

/**
 * Splits a leading YAML block delimited by "---" lines. A leading BOM is not content, as in the Go
 * parser: it neither hides the block nor stays in `body`.
 */
export function splitFrontmatter(raw: string): {
  body: string;
  lines: number;
  yaml: string | null;
} {
  const src = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
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

/** Records what scanInline found on one line of the body (offsets made absolute with `base`). */
function addSpans(doc: NoteDocument, spans: InlineSpan[], lineNo: number, base: number): void {
  for (const sp of spans) {
    switch (sp.kind) {
      case 'wikilink':
        doc.links.push({
          line: lineNo,
          kind: 'wikilink',
          target: sp.target,
          heading: sp.heading,
          block: sp.block,
          alias: sp.alias,
          embed: sp.embed,
          start: base + sp.from,
          end: base + sp.to,
          targetStart: base + sp.targetFrom,
          targetEnd: base + sp.targetTo,
        });
        break;
      case 'link':
        doc.links.push({
          line: lineNo,
          kind: sp.linkKind,
          target: sp.target,
          heading: '',
          block: '',
          alias: sp.text,
          embed: sp.embed,
          start: base + sp.from,
          end: base + sp.to,
          targetStart: base + sp.targetFrom,
          targetEnd: base + sp.targetTo,
        });
        break;
      case 'tag':
        doc.tags.push({ line: lineNo, name: sp.name });
        break;
      case 'blockId':
        doc.blockIds.push({ line: lineNo, id: sp.id });
        break;
      case 'task':
        doc.tasks.push({ line: lineNo, state: sp.state, text: sp.text });
        break;
      case 'footnoteDef':
        doc.footnotes.push(sp.label);
        break;
      case 'footnoteInline': {
        // No label: the index names them ^1, ^2, … in document order.
        const inline = doc.footnotes.filter((x) => x.startsWith('^')).length + 1;
        doc.footnotes.push(`^${inline}`);
        break;
      }
      default:
        break;
    }
  }
}

function headingText(node: MdHeading, lines: string[]): string {
  const start = node.position?.start.line ?? 1;
  const end = node.position?.end.line ?? start;
  const raw = lines.slice(start - 1, end);
  // The CR of a CRLF line is a line ending, not text: "# B #\r" closes its heading like "# B #".
  const first = (raw[0] ?? '').replace(/\r$/, '');
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
  const scan = scanBody(body);
  const { lines } = scan;
  const visit = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'heading') {
      const h = node as MdHeading;
      const text = headingText(h, lines);
      if (text !== '')
        doc.headings.push({ level: h.depth, text, line: (h.position?.start.line ?? 1) + fm.lines });
    }
    for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[])
      visit(child);
  };
  visit(scan.tree);

  const bodyStart = src.length - body.length;
  lines.forEach((_raw, i) => {
    addSpans(doc, scan.spans[i] ?? [], i + 1 + fm.lines, bodyStart + (scan.starts[i] ?? 0));
  });
  doc.wordCount = countWords(body);
  return doc;
}
