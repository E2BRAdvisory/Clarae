// Slash commands: typing "/" at the start of a line or after whitespace opens a menu of
// block-level actions (headings, lists, callout, code block, table, template, ...). Items either
// insert text or run a command of the registry (by id) once the typed "/query" is removed.
// It never triggers inside code, frontmatter, math or in the middle of a word or URL.
import { syntaxTree } from '@codemirror/language';
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { splitFrontmatter } from '@memobrain/markdown';
import i18next from 'i18next';
import { setHeading } from '../editor/commands';

export interface SlashItem {
  id: string;
  /** i18n key of the label ("slash.<id>"); also the search text together with `keywords`. */
  keywords: string;
  /** Text to insert; "|" marks where the cursor goes (removed from the text). */
  insert?: string;
  /** Registry command to run instead (it acts on the active editor). */
  command?: string;
  /** Direct editor action (formatting functions shared with the registry). */
  action?: (view: EditorView) => boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Today as YYYY-MM-DD in local time. */
export function todayText(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The curated subset of commands offered by the menu. */
export const slashItems: readonly SlashItem[] = [
  { id: 'h1', keywords: 'heading 1 h1 titolo', action: setHeading(1) },
  { id: 'h2', keywords: 'heading 2 h2 titolo', action: setHeading(2) },
  { id: 'h3', keywords: 'heading 3 h3 titolo', action: setHeading(3) },
  { id: 'bullet', keywords: 'bullet list elenco puntato', command: 'editor:bullet' },
  { id: 'numbered', keywords: 'numbered list elenco numerato', command: 'editor:numbered' },
  { id: 'task', keywords: 'task todo checkbox attivita', command: 'editor:task' },
  { id: 'quote', keywords: 'quote blockquote citazione', command: 'editor:quote' },
  { id: 'callout', keywords: 'callout note admonition', insert: '> [!note] |\n> ' },
  { id: 'code', keywords: 'code block codice', insert: '```\n|\n```' },
  {
    id: 'table',
    keywords: 'table tabella',
    insert: '| Column 1 | Column 2 |\n| --- | --- |\n| | |',
  },
  { id: 'divider', keywords: 'divider rule separator linea separatore', insert: '---\n|' },
  { id: 'math', keywords: 'math latex formula equation', insert: '$$\n|\n$$' },
  { id: 'link', keywords: 'link collegamento', command: 'editor:link' },
  { id: 'wikilink', keywords: 'wikilink internal link', insert: '[[|]]' },
  { id: 'embed', keywords: 'embed incorpora transclusion', insert: '![[|]]' },
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

const CODE_NODES = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'CodeText',
  'CodeMark',
  'CodeInfo',
  'URL',
  'Autolink',
  'HTMLBlock',
  'Comment',
  'CommentBlock',
]);

/** True where a slash must stay a plain character: code, math, frontmatter, URLs. */
export function inProtectedContext(state: EditorState, pos: number): boolean {
  const doc = state.doc;
  const fm = splitFrontmatter(doc.toString());
  if (fm.lines > 0 && doc.lineAt(pos).number <= fm.lines) return true;
  for (const side of [-1, 1] as const) {
    let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(
      state,
    ).resolveInner(pos, side);
    while (n) {
      if (CODE_NODES.has(n.name)) return true;
      n = n.parent;
    }
  }
  // Display math: an odd number of "$$" lines above the cursor.
  let open = false;
  for (let i = 1; i < doc.lineAt(pos).number; i++)
    if (doc.line(i).text.trim() === '$$') open = !open;
  if (open) return true;
  const line = doc.lineAt(pos);
  const dollars = line.text.slice(0, pos - line.from).split('$').length - 1;
  return dollars % 2 === 1;
}

export interface SlashOptions {
  enabled: () => boolean;
  /** Runs a registry command by id (loaded lazily to keep the editor free of the registry). */
  run: (id: string) => void;
}

function label(it: SlashItem): string {
  return i18next.t(`slash.${it.id}`);
}

/** Items matching the query, best first (prefix of the label, then any keyword). */
export function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase();
  if (!q) return [...slashItems];
  const scored: [number, SlashItem][] = [];
  for (const it of slashItems) {
    const l = label(it).toLowerCase();
    const hay = `${l} ${it.keywords}`.toLowerCase();
    if (l.startsWith(q) || it.id.startsWith(q)) scored.push([0, it]);
    else if (hay.split(/\s+/).some((w) => w.startsWith(q))) scored.push([1, it]);
    else if (hay.includes(q)) scored.push([2, it]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, it]) => it);
}

/** The completion source of the slash menu. */
export function slashCompletionSource(o: SlashOptions): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    if (!o.enabled() || context.state.readOnly) return null;
    const line = context.state.doc.lineAt(context.pos);
    const m = slashMatch(line.text, context.pos - line.from);
    if (!m) return null;
    if (inProtectedContext(context.state, context.pos)) return null;
    const items = filterItems(m.query);
    if (items.length === 0) return null;
    const from = line.from + m.start;
    return {
      from,
      filter: false,
      options: items.map<Completion>((it, i) => ({
        label: `/${label(it)}`,
        type: 'keyword',
        boost: items.length - i,
        apply: (view, _c, a, b) => {
          if (it.action) {
            view.dispatch({ changes: { from: a, to: b, insert: '' }, selection: { anchor: a } });
            it.action(view);
          } else if (it.command) {
            view.dispatch({ changes: { from: a, to: b, insert: '' }, selection: { anchor: a } });
            o.run(it.command);
          } else {
            const raw = it.id === 'date' ? todayText() : (it.insert ?? '');
            const cursor = raw.indexOf('|');
            const text = cursor >= 0 ? raw.replace('|', '') : raw;
            view.dispatch({
              changes: { from: a, to: b, insert: text },
              selection: { anchor: a + (cursor >= 0 ? cursor : text.length) },
            });
          }
          view.focus();
        },
      })),
    };
  };
}
