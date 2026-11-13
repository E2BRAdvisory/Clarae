// Find and replace in the Live editor (A-W5c): the search of the document the user sees, with the options
// of the Source editor (regular expression, match case, replace all). It looks for text in the blocks of
// the document, not for the Markdown that writes them: `**bold**` is found as `bold`, and a search for
// `**` finds nothing (ADR-0049, section 9). The plugin holds the query, the matches and their
// decorations; the bar that drives it (findBar.ts) is the editor's own frame, outside the document.
//
// Replacing is an edit of the user like any other (one undo step, `replace all` included): the layer
// above writes only the blocks it touches. Matches never span two blocks, and never cross a node that is
// not text (an image, a link): such a match is not offered, so a replacement cannot destroy one.
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

export interface FindQuery {
  search: string;
  caseSensitive: boolean;
  regex: boolean;
  replace: string;
}

export interface Match {
  from: number;
  to: number;
  /** The regular expression's result (the captures a replacement may use), null for a plain search. */
  result: RegExpExecArray | null;
}

export interface FindState {
  open: boolean;
  query: FindQuery;
  /** The regular expression does not compile. */
  invalid: boolean;
  matches: readonly Match[];
  /** More matches than are kept. */
  truncated: boolean;
  /** The match the selection is on, or -1. */
  current: number;
  decorations: DecorationSet;
}

export interface FindMeta {
  open?: boolean;
  query?: Partial<FindQuery>;
}

export const findKey = new PluginKey<FindState>('clarae-live-find');

export const EMPTY_QUERY: FindQuery = {
  search: '',
  caseSensitive: false,
  regex: false,
  replace: '',
};
/** More matches than this are not kept (a search for `e` in a long note). */
export const MAX_MATCHES = 5000;

const LEAF = '￼';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The regular expression of a query, or null when there is nothing to look for or it does not compile. */
export function queryRegExp(q: FindQuery): RegExp | null | 'invalid' {
  if (q.search === '') return null;
  try {
    return new RegExp(
      q.regex ? q.search : escapeRegExp(q.search),
      `gm${q.caseSensitive ? '' : 'i'}`,
    );
  } catch {
    return 'invalid';
  }
}

interface Segment {
  /** Index in the text of the block. */
  at: number;
  /** Position in the document. */
  pos: number;
  length: number;
}

/** The text of a textblock as the user reads it, and where each piece of it is in the document. */
function blockText(block: PMNode, pos: number): { text: string; segments: Segment[] } {
  let text = '';
  const segments: Segment[] = [];
  block.descendants((node, offset) => {
    if (node.isText) {
      segments.push({ at: text.length, pos: pos + 1 + offset, length: node.nodeSize });
      text += node.text;
    } else if (node.isLeaf) {
      text += node.type.name === 'hardbreak' ? '\n' : LEAF;
    }
    return true;
  });
  return { text, segments };
}

/** The document position of the character at `index` of a block's text, or null when it is not text. */
function positionOf(segments: readonly Segment[], index: number): number | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid] as Segment;
    if (index < s.at) hi = mid - 1;
    else if (index >= s.at + s.length) lo = mid + 1;
    else return s.pos + (index - s.at);
  }
  return null;
}

export function findMatches(
  doc: PMNode,
  q: FindQuery,
): { matches: Match[]; invalid: boolean; truncated: boolean } {
  const re = queryRegExp(q);
  if (re === null) return { matches: [], invalid: false, truncated: false };
  if (re === 'invalid') return { matches: [], invalid: true, truncated: false };
  const matches: Match[] = [];
  let truncated = false;
  doc.descendants((node, pos) => {
    if (truncated) return false;
    if (!node.isTextblock) return true;
    const { text, segments } = blockText(node, pos);
    if (text === '') return false;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0] === '') {
        re.lastIndex++;
        continue;
      }
      const start = positionOf(segments, m.index);
      const last = positionOf(segments, m.index + m[0].length - 1);
      // text all the way: no node between the ends, so what the match covers is what it says
      if (start !== null && last !== null && last + 1 - start === m[0].length) {
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({ from: start, to: last + 1, result: q.regex ? m : null });
      }
    }
    return false;
  });
  return { matches, invalid: false, truncated };
}

/** What `$1`, `$&`, `$<name>` and `$$` of a replacement stand for in a regular expression search. */
export function expandReplacement(template: string, result: RegExpExecArray): string {
  return template.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (all, ref: string) => {
    if (ref === '$') return '$';
    if (ref === '&') return result[0];
    if (ref.startsWith('<')) return result.groups?.[ref.slice(1, -1)] ?? all;
    const n = Number(ref);
    return n >= 1 && n < result.length ? (result[n] ?? '') : all;
  });
}

const replacementOf = (m: Match, q: FindQuery): string => {
  const text = m.result ? expandReplacement(q.replace, m.result) : q.replace;
  return text.replace(/\r\n?|\n/g, ' ');
};

/** The index of the match the selection is exactly on, or -1. */
function currentOf(
  matches: readonly Match[],
  state: { selection: { from: number; to: number } },
): number {
  const { from, to } = state.selection;
  let lo = 0;
  let hi = matches.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = matches[mid] as Match;
    if (m.from < from) lo = mid + 1;
    else if (m.from > from) hi = mid - 1;
    else return m.to === to ? mid : -1;
  }
  return -1;
}

function decorate(doc: PMNode, matches: readonly Match[], current: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const out: Decoration[] = [];
  const blocks = new Set<number>();
  matches.forEach((m, i) => {
    out.push(
      Decoration.inline(m.from, m.to, {
        class: i === current ? 'live-find-match live-find-current' : 'live-find-match',
      }),
    );
    const $from = doc.resolve(m.from);
    // a code block is an editor of its own: it cannot show the match, so the block says it has one
    if ($from.parent.type.name === 'code_block' && !blocks.has($from.before())) {
      blocks.add($from.before());
      out.push(Decoration.node($from.before(), $from.after(), { class: 'live-find-block' }));
    }
  });
  return DecorationSet.create(doc, out);
}

function compute(state: EditorState, query: FindQuery, open: boolean): FindState {
  if (!open || query.search === '') {
    return {
      open,
      query,
      invalid: false,
      matches: [],
      truncated: false,
      current: -1,
      decorations: DecorationSet.empty,
    };
  }
  const { matches, invalid, truncated } = findMatches(state.doc, query);
  const current = currentOf(matches, state);
  return {
    open,
    query,
    invalid,
    matches,
    truncated,
    current,
    decorations: decorate(state.doc, matches, current),
  };
}

export const findPlugin = $prose(
  () =>
    new Plugin<FindState>({
      key: findKey,
      state: {
        init: () => ({
          open: false,
          query: EMPTY_QUERY,
          invalid: false,
          matches: [],
          truncated: false,
          current: -1,
          decorations: DecorationSet.empty,
        }),
        apply(tr: Transaction, value, _old, state) {
          const meta = tr.getMeta(findKey) as FindMeta | undefined;
          const open = meta?.open ?? value.open;
          const query = meta?.query ? { ...value.query, ...meta.query } : value.query;
          const queryChanged =
            query.search !== value.query.search ||
            query.regex !== value.query.regex ||
            query.caseSensitive !== value.query.caseSensitive;
          if (open !== value.open || queryChanged || (tr.docChanged && open)) {
            return compute(state, query, open);
          }
          if (query !== value.query) value = { ...value, query };
          if (tr.selectionSet && open && value.matches.length > 0) {
            const current = currentOf(value.matches, state);
            if (current !== value.current) {
              return {
                ...value,
                current,
                decorations: decorate(state.doc, value.matches, current),
              };
            }
          }
          return value;
        },
      },
      props: { decorations: (state) => findKey.getState(state)?.decorations ?? null },
    }),
);

export const findStateOf = (state: EditorState): FindState | undefined => findKey.getState(state);

/** Opens or closes the search, and changes the query. */
export function setFind(view: EditorView, meta: FindMeta): void {
  view.dispatch(view.state.tr.setMeta(findKey, meta));
}

/** Selects a match and shows it. */
function select(view: EditorView, m: Match): void {
  const { doc } = view.state;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, m.from, m.to)).scrollIntoView(),
  );
}

/**
 * Goes to the next (or previous) match from the selection, wrapping round the document; returns its
 * index, or -1 when there is none.
 */
export function findNext(view: EditorView, dir: 1 | -1 = 1): number {
  const s = findKey.getState(view.state);
  if (!s || s.matches.length === 0) return -1;
  const { from, to } = view.state.selection;
  const { matches } = s;
  let index: number;
  if (dir > 0) {
    // from the end of the selection: a selected match is passed
    index = matches.findIndex((m) => m.from >= (s.current >= 0 ? to : from));
    if (index < 0) index = 0;
  } else {
    index = -1;
    for (let i = matches.length - 1; i >= 0; i--) {
      if ((matches[i] as Match).to <= from) {
        index = i;
        break;
      }
    }
    if (index < 0) index = matches.length - 1;
  }
  select(view, matches[index] as Match);
  return index;
}

/** Replaces the match the selection is on and goes on to the next one; false when none is selected. */
export function replaceCurrent(view: EditorView): boolean {
  const s = findKey.getState(view.state);
  if (!s || s.current < 0) {
    findNext(view, 1);
    return false;
  }
  const m = s.matches[s.current] as Match;
  const tr = view.state.tr.insertText(replacementOf(m, s.query), m.from, m.to);
  view.dispatch(tr);
  findNext(view, 1);
  return true;
}

/** Replaces every match, as one step of the history; returns how many. */
export function replaceAll(view: EditorView): number {
  const s = findKey.getState(view.state);
  if (!s || s.matches.length === 0) return 0;
  const tr = view.state.tr;
  // from the end: the positions of the matches before stay what they are
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i] as Match;
    tr.insertText(replacementOf(m, s.query), m.from, m.to);
  }
  view.dispatch(tr);
  return s.matches.length;
}
