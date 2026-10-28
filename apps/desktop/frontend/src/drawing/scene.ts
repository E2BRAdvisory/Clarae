// Pure helpers for Excalidraw files (.excalidraw is plain JSON). Nothing here imports
// Excalidraw itself, so the helpers are cheap to load and easy to test.

/** Above this size the editor warns (§M3-WP1): the file is rewritten whole on every save. */
export const DRAWING_WARN_BYTES = 10 * 1024 * 1024;

export const EMPTY_DRAWING = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'memobrain',
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
  /** Other top-level keys of the file (MemoBrain's per-drawing settings live in `memobrain`). */
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
    extra: Object.fromEntries(Object.entries(o).filter(([k]) => !KNOWN_ROOT_KEYS.includes(k))),
  };
}

/**
 * A cheap change signature of a scene: element ids and versions plus the number of files.
 * Excalidraw calls onChange for selection and scroll too; only a different signature is an edit.
 */
export function sceneSignature(
  elements: readonly { id?: unknown; version?: unknown }[],
  fileCount: number,
): string {
  let s = `${fileCount}|`;
  for (const e of elements) s += `${String(e.id)}:${String(e.version)},`;
  return s;
}

export function isOverLimit(text: string): boolean {
  return text.length > DRAWING_WARN_BYTES;
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
