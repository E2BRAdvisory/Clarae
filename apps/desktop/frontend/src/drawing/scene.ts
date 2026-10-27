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
}

/** Parses a drawing; an empty file is an empty scene, anything else invalid throws. */
export function parseScene(text: string): RawScene {
  if (text.trim() === '') return { elements: [], appState: {}, files: {} };
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

/** The embed that shows a drawing inside a note. */
export function embedMarkdown(path: string): string {
  return `![[${path.split('/').pop() ?? path}]]`;
}

/** File name of an export: "Name.png", "Name@2x.png", "Name.svg". */
export function exportFileName(path: string, format: 'png' | 'svg', scale: number): string {
  const base = (path.split('/').pop() ?? path).replace(/\.excalidraw$/i, '');
  return format === 'png' && scale > 1 ? `${base}@${scale}x.png` : `${base}.${format}`;
}

export function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}
