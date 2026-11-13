// Folding in the Live editor (A-W5c): what the fold gutter of the Source editor does (headings, and with
// them the blocks of `@codemirror/lang-markdown`: the items of a list, the quotes, the code blocks and
// the tables), without changing the document.
//
//   what folds     heading   the blocks that follow it, up to the next heading of its level or above
//                  item      what follows its first block (the nested list, the paragraphs after the first)
//                  quote     the same, for a quote that is not a callout (a callout folds on its own)
//                  code      the code, the header of the block with its language stays
//                  table     the rows below the header
//   the state      the folds are the plugin's own (positions mapped through the edits), never an
//                  attribute of the document: folding is no edit and never makes the note dirty (A4 of the
//                  critique). A fold that the selection moves into (arrow keys, find, go to line, undo)
//                  opens, so the caret is never in what is hidden.
//   what shows     a folded block has its chevron (a button, on the keyboard too); an open one shows its
//                  chevron when the pointer is on its first line (foldHover.ts), so that a note of
//                  thousands of blocks carries no decoration per block.
//   the keys       those of the Source editor (`foldKeymap`): Ctrl-Shift-[ and ], Ctrl-Alt-[ and ] (Cmd-Alt
//                  on the Mac for the first two).
import { keymap } from '@milkdown/kit/prose/keymap';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  Selection,
  type Command,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { i18next } from '../../../i18n';
import { iconElement } from '../../../shell/icons';
import { calloutOf } from '../views/callouts';

export type FoldKind = 'heading' | 'item' | 'quote' | 'code' | 'table';

/** A block that can fold, with what it hides. */
export interface Foldable {
  kind: FoldKind;
  /** Position before the block. */
  pos: number;
  node: PMNode;
  /** What is hidden when it is folded: a range of the document (positions), nothing outside the block but for headings. */
  hidden: { from: number; to: number };
  /** Where the caret goes when it was in what got hidden: the end of what stays visible. */
  visibleEnd: number;
}

/** The foldable block that starts at `pos`, or null (not a block that folds, or nothing to hide). */
export function foldableAt(doc: PMNode, pos: number): Foldable | null {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const end = pos + node.nodeSize;
  switch (node.type.name) {
    case 'heading': {
      const $pos = doc.resolve(pos);
      const parent = $pos.parent;
      const level = Number(node.attrs['level']) || 1;
      let to = end;
      for (let i = $pos.index() + 1; i < parent.childCount; i++) {
        const next = parent.child(i);
        if (next.type.name === 'heading' && (Number(next.attrs['level']) || 1) <= level) break;
        to += next.nodeSize;
      }
      return to > end
        ? { kind: 'heading', pos, node, hidden: { from: end, to }, visibleEnd: end - 1 }
        : null;
    }
    case 'list_item':
    case 'blockquote': {
      if (node.childCount < 2) return null;
      if (node.type.name === 'blockquote' && calloutOf(node, pos)) return null;
      const first = node.child(0).nodeSize;
      return {
        kind: node.type.name === 'list_item' ? 'item' : 'quote',
        pos,
        node,
        hidden: { from: pos + 1 + first, to: end - 1 },
        visibleEnd: pos + first,
      };
    }
    case 'code_block':
      return node.content.size === 0
        ? null
        : {
            kind: 'code',
            pos,
            node,
            hidden: { from: pos + 1, to: end - 1 },
            visibleEnd: pos,
          };
    case 'table': {
      if (node.childCount < 2) return null;
      const first = node.child(0).nodeSize;
      return {
        kind: 'table',
        pos,
        node,
        hidden: { from: pos + 1 + first, to: end - 1 },
        visibleEnd: pos,
      };
    }
    default:
      return null;
  }
}

interface FoldState {
  /** Whether folding is on (the `foldHeadings` setting). */
  enabled: boolean;
  /** The folded blocks: the position before each, and what kind of block it was. */
  folded: ReadonlyMap<number, FoldKind>;
  decorations: DecorationSet;
}

export interface FoldMeta {
  fold?: readonly number[];
  /** Positions to open, or every fold. */
  unfold?: readonly number[] | 'all';
  enabled?: boolean;
}

export const foldKey = new PluginKey<FoldState>('clarae-live-fold');

export const foldStateOf = (state: EditorState): FoldState | undefined => foldKey.getState(state);

/** The folded blocks that are really there, with what each hides. */
function foldedBlocks(doc: PMNode, folded: ReadonlyMap<number, FoldKind>): Foldable[] {
  const out: Foldable[] = [];
  for (const [pos, kind] of folded) {
    const f = foldableAt(doc, pos);
    if (f?.kind === kind) out.push(f);
  }
  return out;
}

function chevron() {
  return (view: EditorView, getPos: () => number | undefined): HTMLElement => {
    const el = document.createElement('span');
    el.className = 'live-fold-chevron';
    el.contentEditable = 'false';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-label', i18next.t('editor.fold.unfold'));
    el.setAttribute('aria-expanded', 'false');
    el.append(iconElement('chevronRight', 16));
    const open = (): void => {
      const at = getPos();
      if (at !== undefined) view.dispatch(view.state.tr.setMeta(foldKey, { unfold: [at] }));
    };
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      open();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    return el;
  };
}

function build(state: { doc: PMNode }, folded: ReadonlyMap<number, FoldKind>): DecorationSet {
  const out: Decoration[] = [];
  for (const f of foldedBlocks(state.doc, folded)) {
    out.push(
      Decoration.node(f.pos, f.pos + f.node.nodeSize, {
        class: `live-folded live-folded-${f.kind}`,
        'data-folded': f.kind,
      }),
      Decoration.widget(f.pos, chevron(), {
        side: -1,
        key: `fold:${f.kind}:${f.node.textContent.length > 0}`,
        stopEvent: () => true,
        ignoreSelection: true,
      }),
    );
    if (f.kind === 'heading') {
      let at = f.hidden.from;
      const end = f.hidden.to;
      const $at = state.doc.resolve(at);
      const parent = $at.parent;
      for (let i = $at.index(); i < parent.childCount && at < end; i++) {
        const child = parent.child(i);
        out.push(Decoration.node(at, at + child.nodeSize, { class: 'live-fold-hidden' }));
        at += child.nodeSize;
      }
    } else if (f.kind === 'item' || f.kind === 'quote' || f.kind === 'table') {
      let at = f.hidden.from;
      for (let i = 1; i < f.node.childCount && at < f.hidden.to; i++) {
        const child = f.node.child(i);
        out.push(Decoration.node(at, at + child.nodeSize, { class: 'live-fold-hidden' }));
        at += child.nodeSize;
      }
    }
  }
  return DecorationSet.create(state.doc, out);
}

/** Maps the folds through an edit; one that no longer is a block of its kind is dropped. */
function mapFolds(
  folded: ReadonlyMap<number, FoldKind>,
  tr: Transaction,
): ReadonlyMap<number, FoldKind> {
  if (folded.size === 0 || !tr.docChanged) return folded;
  const next = new Map<number, FoldKind>();
  for (const [pos, kind] of folded) {
    const at = tr.mapping.map(pos, 1);
    if (foldableAt(tr.doc, at)?.kind === kind) next.set(at, kind);
  }
  return next;
}

function nextFolded(
  folded: ReadonlyMap<number, FoldKind>,
  doc: PMNode,
  meta: FoldMeta | undefined,
): ReadonlyMap<number, FoldKind> {
  if (!meta) return folded;
  let next = folded;
  if (meta.unfold === 'all') next = new Map();
  else if (meta.unfold && meta.unfold.length > 0) {
    next = new Map(next);
    for (const pos of meta.unfold) (next as Map<number, FoldKind>).delete(pos);
  }
  if (meta.fold && meta.fold.length > 0) {
    next = new Map(next);
    for (const pos of meta.fold) {
      const f = foldableAt(doc, pos);
      if (f) (next as Map<number, FoldKind>).set(pos, f.kind);
    }
  }
  return next;
}

const sameFolds = (a: ReadonlyMap<number, FoldKind>, b: ReadonlyMap<number, FoldKind>): boolean =>
  a === b || (a.size === b.size && [...a].every(([k, v]) => b.get(k) === v));

export const foldPlugin = (enabled: boolean) =>
  $prose(
    () =>
      new Plugin<FoldState>({
        key: foldKey,
        state: {
          init: (_, state) => ({
            enabled,
            folded: new Map(),
            decorations: DecorationSet.create(state.doc, []),
          }),
          apply(tr, value, _old, state) {
            const meta = tr.getMeta(foldKey) as FoldMeta | undefined;
            const on = meta?.enabled ?? value.enabled;
            let folded = on ? mapFolds(value.folded, tr) : new Map<number, FoldKind>();
            if (on) folded = nextFolded(folded, state.doc, meta);
            if (on === value.enabled && !tr.docChanged && sameFolds(folded, value.folded)) {
              return value;
            }
            return { enabled: on, folded, decorations: build(state, folded) };
          },
        },
        // A fold the selection moved into opens: the caret is never in what is hidden. A selection that
        // reaches beyond the hidden part (select all) leaves it alone.
        appendTransaction(trs, _old, state) {
          const s = foldKey.getState(state);
          if (!s || s.folded.size === 0) return null;
          if (!trs.some((t) => t.selectionSet || t.docChanged)) return null;
          const { from, to } = state.selection;
          const open: number[] = [];
          for (const f of foldedBlocks(state.doc, s.folded)) {
            if (from >= f.hidden.from && to <= f.hidden.to) open.push(f.pos);
          }
          return open.length > 0
            ? state.tr.setMeta(foldKey, { unfold: open } satisfies FoldMeta)
            : null;
        },
        props: { decorations: (state) => foldKey.getState(state)?.decorations ?? null },
      }),
  );

// ---- the commands ----------------------------------------------------------------------------------

/** The blocks that fold and hold the head of the selection, the innermost first. */
function foldablesAround(state: EditorState): Foldable[] {
  const { $head } = state.selection;
  const out: Foldable[] = [];
  for (let d = $head.depth; d > 0; d--) {
    const f = foldableAt(state.doc, $head.before(d));
    if (f) out.push(f);
  }
  return out;
}

/** Folds the innermost block at the selection that is not folded yet. */
export const foldCode: Command = (state, dispatch) => {
  const s = foldKey.getState(state);
  if (!s?.enabled) return false;
  const target = foldablesAround(state).find((f) => !s.folded.has(f.pos));
  if (!target) return false;
  if (dispatch) dispatch(foldTransaction(state, [target]));
  return true;
};

/** Opens the innermost folded block at the selection. */
export const unfoldCode: Command = (state, dispatch) => {
  const s = foldKey.getState(state);
  if (!s?.enabled) return false;
  const target = foldablesAround(state).find((f) => s.folded.has(f.pos));
  if (!target) return false;
  if (dispatch) dispatch(state.tr.setMeta(foldKey, { unfold: [target.pos] } satisfies FoldMeta));
  return true;
};

/** Folds every block that can fold but the ones the head of the selection is in or under. */
export const foldAll: Command = (state, dispatch) => {
  const s = foldKey.getState(state);
  if (!s?.enabled) return false;
  const head = state.selection.head;
  // what holds the head (a block it is in, or the section of a heading it is under) stays open
  const keep = new Set(foldablesAround(state).map((f) => f.pos));
  const targets: Foldable[] = [];
  state.doc.descendants((node, pos) => {
    const f = foldableAt(state.doc, pos);
    if (f && !keep.has(pos) && !(head >= f.hidden.from && head <= f.hidden.to)) targets.push(f);
    return !(node.isTextblock || node.type.name === 'table');
  });
  if (targets.length === 0) return false;
  if (dispatch) dispatch(foldTransaction(state, targets));
  return true;
};

export const unfoldAll: Command = (state, dispatch) => {
  const s = foldKey.getState(state);
  if (!s?.enabled || s.folded.size === 0) return false;
  if (dispatch) dispatch(state.tr.setMeta(foldKey, { unfold: 'all' } satisfies FoldMeta));
  return true;
};

/** Flips the fold of the block at `pos`; true when it did something. */
export function toggleFoldAt(view: EditorView, pos: number): boolean {
  const s = foldKey.getState(view.state);
  const f = foldableAt(view.state.doc, pos);
  if (!s?.enabled || !f) return false;
  if (s.folded.has(pos)) {
    view.dispatch(view.state.tr.setMeta(foldKey, { unfold: [pos] } satisfies FoldMeta));
  } else {
    view.dispatch(foldTransaction(view.state, [f]));
  }
  return true;
}

/** The fold of some blocks; a caret in what they hide goes to the end of what stays visible. */
function foldTransaction(state: EditorState, targets: readonly Foldable[]): Transaction {
  const tr = state.tr.setMeta(foldKey, { fold: targets.map((f) => f.pos) } satisfies FoldMeta);
  const { from, to } = state.selection;
  const hit = targets.find((f) => from >= f.hidden.from && to <= f.hidden.to);
  if (hit) tr.setSelection(Selection.near(tr.doc.resolve(hit.visibleEnd), -1));
  return tr;
}

export const foldKeys = $prose(() =>
  keymap({
    'Ctrl-Shift-[': foldCode,
    'Cmd-Alt-[': foldCode,
    'Ctrl-Shift-]': unfoldCode,
    'Cmd-Alt-]': unfoldCode,
    'Ctrl-Alt-[': foldAll,
    'Ctrl-Alt-]': unfoldAll,
  }),
);
