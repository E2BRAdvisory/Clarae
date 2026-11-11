// The list of the slash menu and the rules of what a typed "/query" is: the same for every editor that
// shows the menu (the completion source of CodeMirror in slash.ts, the popup of the Live editor in
// editor/live/input/suggest.ts). Nothing here knows an editor.
import i18next from 'i18next';
import type { EditorCommand } from '../editor/handle';

export interface SlashItem {
  id: string;
  /** i18n key of the label ("slash.<id>"); also the search text together with `keywords`. */
  keywords: string;
  /** Text to insert as it is (a snippet with a caret is an editor command instead: `exec`). */
  insert?: string;
  /** Registry command to run instead (it acts on the active editor). */
  command?: string;
  /** Editor command to run through the handle of the editor (the engine implements it). */
  exec?: EditorCommand;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Today as YYYY-MM-DD in local time. */
export function todayText(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The curated subset of commands offered by the menu. What puts the caret inside the syntax (a
 * callout, a code block, a table, a link) is a command of the editor, which each engine does in its own
 * way: a text snippet with a caret mark has no meaning in a document that has no such text.
 */
export const slashItems: readonly SlashItem[] = [
  { id: 'h1', keywords: 'heading 1 h1 titolo', exec: 'heading-1' },
  { id: 'h2', keywords: 'heading 2 h2 titolo', exec: 'heading-2' },
  { id: 'h3', keywords: 'heading 3 h3 titolo', exec: 'heading-3' },
  { id: 'bullet', keywords: 'bullet list elenco puntato', command: 'editor:bullet' },
  { id: 'numbered', keywords: 'numbered list elenco numerato', command: 'editor:numbered' },
  { id: 'task', keywords: 'task todo checkbox attivita', command: 'editor:task' },
  { id: 'quote', keywords: 'quote blockquote citazione', command: 'editor:quote' },
  { id: 'callout', keywords: 'callout note admonition', exec: 'callout' },
  { id: 'code', keywords: 'code block codice', exec: 'code-block' },
  { id: 'table', keywords: 'table tabella', exec: 'table' },
  { id: 'divider', keywords: 'divider rule separator linea separatore', exec: 'separator' },
  { id: 'math', keywords: 'math latex formula equation', exec: 'math' },
  { id: 'link', keywords: 'link collegamento', command: 'editor:link' },
  { id: 'wikilink', keywords: 'wikilink internal link', exec: 'wikilink' },
  { id: 'embed', keywords: 'embed incorpora transclusion', exec: 'embed' },
  { id: 'drawing', keywords: 'drawing disegno lavagna sketch', command: 'drawing:new' },
  { id: 'template', keywords: 'template modello', command: 'template:insert' },
  { id: 'date', keywords: 'today date data oggi', insert: '' },
];

/** The "/query" in front of the cursor, or null when the menu must not open. */
export function slashMatch(lineText: string, col: number): { query: string; start: number } | null {
  const before = lineText.slice(0, col);
  const m = /(?:^|\s)\/([\p{L}\p{N}-]*)$/u.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  return { query, start: col - query.length - 1 };
}

export interface SlashOptions {
  enabled: () => boolean;
  /** Runs a registry command by id (loaded lazily to keep the editor free of the registry). */
  run: (id: string) => void;
}

export function slashLabel(it: SlashItem): string {
  return i18next.t(`slash.${it.id}`);
}

/** Items matching the query, best first (prefix of the label, then any keyword). */
export function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase();
  if (!q) return [...slashItems];
  const scored: [number, SlashItem][] = [];
  for (const it of slashItems) {
    const l = slashLabel(it).toLowerCase();
    const hay = `${l} ${it.keywords}`.toLowerCase();
    if (l.startsWith(q) || it.id.startsWith(q)) scored.push([0, it]);
    else if (hay.split(/\s+/).some((w) => w.startsWith(q))) scored.push([1, it]);
    else if (hay.includes(q)) scored.push([2, it]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, it]) => it);
}
