// Autocomplete for [[wikilinks]] (notes, aliases, #headings, #^blocks), #tags
// and frontmatter property names. Ranking happens in the backend (fuzzy), so
// the sources ask again on every keystroke instead of filtering client side.
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { splitFrontmatter } from '@nodus/markdown';
import type { Suggestion, SuggestKind } from '../app/api';

export type LinkFormat = 'shortest' | 'path' | 'relative';

export interface CompletionBackend {
  suggest(kind: SuggestKind, query: string, notePath: string): Promise<Suggestion[]>;
  resolve(from: string, target: string): Promise<string>;
}

export interface CompletionOptions {
  backend: CompletionBackend;
  notePath: () => string;
  linkFormat: () => LinkFormat;
}

const stripMd = (p: string): string => p.replace(/\.md$/, '');

/** The text to put inside [[ ]] for a note, honoring the "link format" setting. */
export function linkTextFor(
  s: Suggestion,
  from: string,
  format: LinkFormat,
  ambiguous: boolean,
): string {
  const path = stripMd(s.path);
  if (format === 'path') return path;
  if (format === 'relative') {
    const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
    const target = path.split('/');
    let i = 0;
    while (i < fromDir.length && i < target.length - 1 && fromDir[i] === target[i]) i++;
    return [...fromDir.slice(i).map(() => '..'), ...target.slice(i)].join('/');
  }
  return ambiguous ? path : stripMd(s.label);
}

function closing(context: CompletionContext, to: number): string {
  return context.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]';
}

function wikilinkSource(o: CompletionOptions): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const m = context.matchBefore(/\[\[[^\]\n]*$/);
    if (!m) return null;
    const typed = m.text.slice(2);
    const from = m.from + 2;
    const here = o.notePath();

    const hash = typed.indexOf('#');
    if (hash >= 0) {
      const targetText = typed.slice(0, hash);
      const rest = typed.slice(hash + 1);
      const notePath = targetText ? await o.backend.resolve(here, targetText) : here;
      if (!notePath) return null;
      if (rest.startsWith('^')) {
        const items = await o.backend.suggest('blocks', rest.slice(1), notePath);
        return {
          from,
          filter: false,
          options: items.map<Completion>((s) => ({
            label: `${targetText}#^${s.label}`,
            displayLabel: `^${s.label}`,
            detail: s.detail,
            type: 'text',
            apply: (view, _c, a, b) =>
              view.dispatch({
                changes: {
                  from: a,
                  to: b,
                  insert: `${targetText}#^${s.label}${closing(context, b)}`,
                },
              }),
          })),
        };
      }
      const items = await o.backend.suggest('headings', rest, notePath);
      return {
        from,
        filter: false,
        options: items.map<Completion>((s) => ({
          label: `${targetText}#${s.label}`,
          displayLabel: s.label,
          detail: s.detail,
          type: 'keyword',
          apply: (view, _c, a, b) =>
            view.dispatch({
              changes: { from: a, to: b, insert: `${targetText}#${s.label}${closing(context, b)}` },
            }),
        })),
      };
    }

    const items = await o.backend.suggest('notes', typed, '');
    const counts = new Map<string, number>();
    for (const s of items)
      if (s.kind === 'note')
        counts.set(s.label.toLowerCase(), (counts.get(s.label.toLowerCase()) ?? 0) + 1);
    return {
      from,
      filter: false,
      options: items.map<Completion>((s) => {
        const ambiguous = (counts.get(s.label.toLowerCase()) ?? 0) > 1;
        const text = linkTextFor(s, here, o.linkFormat(), ambiguous);
        const insert = s.kind === 'alias' ? `${text}|${s.label}` : text;
        return {
          label: s.kind === 'alias' ? s.label : text,
          detail: s.kind === 'alias' ? `→ ${s.detail}` : s.detail,
          type: s.kind === 'alias' ? 'variable' : 'class',
          apply: (view, _c, a, b) =>
            view.dispatch({ changes: { from: a, to: b, insert: insert + closing(context, b) } }),
        };
      }),
    };
  };
}

function tagSource(o: CompletionOptions): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const m = context.matchBefore(/(?:^|[\s([{,;])#[\p{L}\p{N}_\-/]*$/u);
    if (!m) return null;
    const hashAt = m.text.lastIndexOf('#');
    const typed = m.text.slice(hashAt + 1);
    // "# " at the start of a line is a heading, not a tag: only complete once a character follows.
    if (typed === '' && !context.explicit) return null;
    const items = await o.backend.suggest('tags', typed, '');
    return {
      from: m.from + hashAt + 1,
      filter: false,
      options: items.map<Completion>((s) => ({
        label: s.label,
        detail: `${s.detail}×`,
        type: 'keyword',
      })),
    };
  };
}

function propertySource(o: CompletionOptions): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const fm = splitFrontmatter(context.state.doc.toString());
    if (fm.lines === 0) return null;
    const line = context.state.doc.lineAt(context.pos);
    if (line.number < 2 || line.number >= fm.lines) return null;
    const m = context.matchBefore(/^[\w-]*$/);
    if (!m || line.text.slice(0, context.pos - line.from).includes(':')) return null;
    if (m.from !== line.from) return null;
    const items = await o.backend.suggest('properties', m.text, '');
    return {
      from: m.from,
      filter: false,
      options: items.map<Completion>((s) => ({
        label: s.label,
        detail: s.detail,
        type: 'property',
        apply: (view, _c, a, b) =>
          view.dispatch({ changes: { from: a, to: b, insert: `${s.label}: ` } }),
      })),
    };
  };
}

export function ofmCompletionSources(o: CompletionOptions): CompletionSource[] {
  return [wikilinkSource(o), tagSource(o), propertySource(o)];
}
