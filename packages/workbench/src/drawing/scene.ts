// Pure helpers for Excalidraw files (.excalidraw is plain JSON). Nothing here imports
// Excalidraw itself, so the helpers are cheap to load and easy to test.
import { normalizeFileExtra } from './meta';

/**
 * Above this size the core does not index the content of a drawing (`maxParseBytes` of the
 * indexer): its text is not searchable and its links are not in the backlinks or the graph.
 */
export const DRAWING_SEARCH_BYTES = 8 * 1024 * 1024;
/**
 * Above this size the editor warns that the drawing is heavy (§M3-WP1, `drawing.MaxSize` in the
 * core): the file is rewritten whole on every save.
 */
export const DRAWING_WARN_BYTES = 10 * 1024 * 1024;

export const EMPTY_DRAWING = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'clarae',
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  },
  null,
  2,
);

export interface RawScene {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  /** Other top-level keys of the file (Clarae's per-drawing settings live in `clarae`). */
  extra: Record<string, unknown>;
}

const KNOWN_ROOT_KEYS = ['type', 'version', 'source', 'elements', 'appState', 'files'];

/** Parses a drawing; an empty file is an empty scene, anything else invalid throws. */
export function parseScene(text: string): RawScene {
  if (text.trim() === '') return { elements: [], appState: {}, files: {}, extra: {} };
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('not an Excalidraw file');
  const o = raw as Record<string, unknown>;
  if (o['type'] !== undefined && o['type'] !== 'excalidraw')
    throw new Error(`not an Excalidraw file (type ${JSON.stringify(o['type'])})`);
  if (!Array.isArray(o['elements'])) throw new Error('not an Excalidraw file (no elements)');
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    elements: o['elements'] as Record<string, unknown>[],
    appState: obj(o['appState']),
    files: obj(o['files']),
    // The settings of a 1.x file are read from its legacy key; saving writes the new one only.
    extra: normalizeFileExtra(
      Object.fromEntries(Object.entries(o).filter(([k]) => !KNOWN_ROOT_KEYS.includes(k))),
    ),
  };
}

/**
 * A cheap change signature of a scene: element ids and versions in order, plus the number of
 * files. Excalidraw calls onChange for selection and scroll too; only a different signature is an
 * edit. Two rolling hashes instead of the ids spelled out: this runs on every pointer move over a
 * scene of thousands of elements. Never the empty string.
 */
export function sceneSignature(
  elements: readonly { id?: unknown; version?: unknown }[],
  fileCount: number,
): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (const e of elements) {
    const id = typeof e.id === 'string' ? e.id : String(e.id);
    for (let i = 0; i < id.length; i++) {
      const c = id.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = (Math.imul(b, 33) + c) | 0;
    }
    const v = typeof e.version === 'number' ? e.version | 0 : -1;
    // the version, then a mark that ends the element
    a = Math.imul(Math.imul(a ^ v, 0x01000193) ^ 0x2c, 0x01000193);
    b = (Math.imul((Math.imul(b, 33) + v) | 0, 33) + 0x2c) | 0;
  }
  return `${fileCount}|${elements.length}|${a >>> 0}|${b >>> 0}`;
}

/** The size of a text as a file holds it (UTF-8), counted without encoding it. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // a pair of surrogates is one character of four bytes
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** What the size of a drawing costs: `search` (not indexed any more), `slow` (heavy as well). */
export type SizeWarning = 'search' | 'slow' | null;

/**
 * The warning for a drawing of this text, by its size on disk. Both limits are the core's, which
 * compares the bytes of the file: a character is one to three bytes, so most drawings are
 * settled by their length alone and only the large ones are counted.
 */
export function sizeWarning(text: string): SizeWarning {
  if (text.length * 3 <= DRAWING_SEARCH_BYTES) return null;
  if (text.length > DRAWING_WARN_BYTES) return 'slow';
  const bytes = utf8Bytes(text);
  if (bytes > DRAWING_WARN_BYTES) return 'slow';
  return bytes > DRAWING_SEARCH_BYTES ? 'search' : null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "Drawing 2026-10-24 12.30" (no characters that file systems dislike). */
export function drawingBaseName(now: Date): string {
  return `Drawing ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
}

/** The embed that shows a drawing inside a note, optionally with a width in px. */
export function embedMarkdown(path: string, width = 0): string {
  const name = path.split('/').pop() ?? path;
  return width > 0 ? `![[${name}|${width}]]` : `![[${name}]]`;
}

export type ElementLink =
  | { kind: 'note'; target: string; heading: string; block: string }
  | { kind: 'external'; url: string };

/**
 * What the `link` field of an element points to: a wikilink ("[[Note#Heading|alias]]",
 * "[[Note#^block]]"), a web URL, or nothing usable.
 */
export function parseElementLink(link: string | null | undefined): ElementLink | null {
  const text = (link ?? '').trim();
  if (!text) return null;
  const wiki = /^\[\[([^\]]+)\]\]$/.exec(text);
  if (wiki?.[1]) {
    const inner = (wiki[1].split('|')[0] ?? '').trim();
    const hash = inner.indexOf('#');
    const target = (hash < 0 ? inner : inner.slice(0, hash)).trim();
    const frag = hash < 0 ? '' : inner.slice(hash + 1).trim();
    const block = frag.startsWith('^') ? frag.slice(1) : '';
    const heading = block ? '' : frag;
    if (!target && !heading && !block) return null;
    return { kind: 'note', target, heading, block };
  }
  if (/^(https?:|mailto:|tel:)/i.test(text)) return { kind: 'external', url: text };
  return null;
}

/** File name of an export: "Name.png", "Name@2x.png", "Name.svg". */
export function exportFileName(path: string, format: 'png' | 'svg', scale: number): string {
  const base = (path.split('/').pop() ?? path).replace(/\.excalidraw$/i, '');
  return format === 'png' && scale > 1 ? `${base}@${scale}x.png` : `${base}.${format}`;
}

export function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

interface Boxed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  link?: string | null;
  isDeleted?: boolean;
}

/** The topmost live element satisfying `pick` under a scene point (bounding box + tolerance). */
export function elementAt<T extends Boxed>(
  elements: readonly T[],
  x: number,
  y: number,
  pick: (e: T) => boolean,
  tolerance = 4,
): T | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (!e || e.isDeleted || !pick(e)) continue;
    const left = Math.min(e.x, e.x + e.width) - tolerance;
    const top = Math.min(e.y, e.y + e.height) - tolerance;
    if (
      x >= left &&
      x <= left + Math.abs(e.width) + 2 * tolerance &&
      y >= top &&
      y <= top + Math.abs(e.height) + 2 * tolerance
    )
      return e;
  }
  return null;
}

/**
 * The topmost element with a usable note link under a scene point. Used to preview the note a
 * link points to on hover.
 */
export function linkedElementAt<T extends Boxed>(
  elements: readonly T[],
  x: number,
  y: number,
  tolerance = 4,
): T | null {
  return elementAt(elements, x, y, (e) => parseElementLink(e.link)?.kind === 'note', tolerance);
}
