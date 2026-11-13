// Slash commands: typing "/" at the start of a line or after whitespace opens a menu of
// block-level actions (headings, lists, callout, code block, table, template, ...). Items either
// insert text, run a command of the editor (`exec`, through its handle) or one of the registry (by
// id) once the typed "/query" is removed.
// It never triggers inside code, frontmatter, math or in the middle of a word or URL.
import { syntaxTree } from '@codemirror/language';
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import { splitFrontmatter } from '@clarae/markdown';
import { codeMirrorHandle } from './CodeMirrorAdapter';
import {
  filterItems,
  slashLabel as label,
  slashMatch,
  todayText,
  type SlashOptions,
} from '../../slash/items';

// The list and the rules of the menu are shared with the Live editor (items.ts); re-exported so that the
// existing imports keep compiling.
export {
  filterItems,
  slashItems,
  slashMatch,
  todayText,
  type SlashItem,
  type SlashOptions,
} from '../../slash/items';

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
          if (it.exec) {
            view.dispatch({ changes: { from: a, to: b, insert: '' }, selection: { anchor: a } });
            codeMirrorHandle(view).exec(it.exec);
          } else if (it.command) {
            view.dispatch({ changes: { from: a, to: b, insert: '' }, selection: { anchor: a } });
            o.run(it.command);
          } else {
            // inserted as it is: a "|" in it is a character (a table), never the place of the caret
            const text = it.id === 'date' ? todayText() : (it.insert ?? '');
            view.dispatch({
              changes: { from: a, to: b, insert: text },
              selection: { anchor: a + text.length },
            });
          }
          view.focus();
        },
      })),
    };
  };
}
