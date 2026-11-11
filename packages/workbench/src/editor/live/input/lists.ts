// Moving blocks with Alt+Up and Alt+Down (A-W5b). In Source the keys move the selected lines
// (`defaultKeymap` of CodeMirror), which is how the items of a list are reordered; in Live they move
// the unit the selection is in: the list items it touches (with what is nested in them), or else the
// blocks of the document. The unit is never part of a table or a code block (an editor of its own), and
// a quote or a callout moves as a whole.
//
// Tab and Shift+Tab (`indentWithTab` in Source) are here too: in a list they sink and lift the item.
// Elsewhere Tab writes a tab character at the caret, which is text the file keeps as it is, and Shift+Tab
// takes away the one before the caret. The key is the editor's in every other place of the text: it
// never writes spaces (the indent plugin of Crepe wrote four wherever the caret was, in the middle of
// a word too), and what has no sense in Markdown (a tab at the start of a paragraph is an indented
// code block, a first item has nothing to sink under) does nothing. Code blocks and tables have
// their own editors, and a read-only editor leaves Tab to the browser.
import { Fragment } from '@milkdown/kit/prose/model';
import { keymap } from '@milkdown/kit/prose/keymap';
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import { goToNextCell } from '@milkdown/kit/prose/tables';
import {
  NodeSelection,
  TextSelection,
  type Command,
  type EditorState,
} from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

/** The containers whose children are the units that move. */
const CONTAINERS = new Set(['bullet_list', 'ordered_list', 'doc']);
/** What the units of a selection must not be inside of. */
const NOT_MOVABLE = new Set(['table', 'code_block']);

function range(state: EditorState) {
  const { $from, $to } = state.selection;
  for (let d = $from.depth; d > 0; d--) if (NOT_MOVABLE.has($from.node(d).type.name)) return null;
  for (let d = $to.depth; d > 0; d--) if (NOT_MOVABLE.has($to.node(d).type.name)) return null;
  return $from.blockRange($to, (node) => CONTAINERS.has(node.type.name));
}

/** Moves the unit of the selection above the one before it (`-1`) or below the one after it (`1`). */
export const moveBlock =
  (dir: -1 | 1): Command =>
  (state, dispatch) => {
    const r = range(state);
    if (!r) return false;
    const { parent, start, end, startIndex, endIndex } = r;
    if (dir < 0 ? startIndex === 0 : endIndex >= parent.childCount) return false;
    if (dispatch) {
      const tr = state.tr;
      const units = tr.doc.slice(start, end).content;
      let delta: number;
      if (dir < 0) {
        const prev = parent.child(startIndex - 1);
        tr.replaceWith(start - prev.nodeSize, end, units.addToEnd(prev));
        delta = -prev.nodeSize;
      } else {
        const next = parent.child(endIndex);
        tr.replaceWith(start, end + next.nodeSize, Fragment.from(next).append(units));
        delta = next.nodeSize;
      }
      // the selection goes with what it was in (a replaced range would leave it at an edge)
      const { selection } = state;
      if (selection instanceof NodeSelection) {
        tr.setSelection(NodeSelection.create(tr.doc, selection.from + delta));
      } else if (selection instanceof TextSelection) {
        tr.setSelection(
          TextSelection.create(tr.doc, selection.anchor + delta, selection.head + delta),
        );
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

export const moveKeys = $prose(() =>
  keymap({
    'Alt-ArrowUp': moveBlock(-1),
    'Alt-ArrowDown': moveBlock(1),
  }),
);

/** The nearest ancestor of the selection that is of a type, with its depth. */
function ancestorOf(state: EditorState, names: ReadonlySet<string>): number {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if (names.has($from.node(d).type.name)) return d;
  return -1;
}

const CODE = new Set(['code_block']);
const CELL = new Set(['table_cell', 'table_header']);
const ITEM = new Set(['list_item']);

/** Tab: the item sinks under the one before it; elsewhere a tab character goes in at the caret. */
export const indentCommand =
  (readOnly: () => boolean): Command =>
  (state, dispatch) => {
    if (readOnly()) return true; // (the indent plugin of Crepe is after this one: it would write)
    if (ancestorOf(state, CODE) >= 0) return true;
    if (ancestorOf(state, CELL) >= 0) {
      goToNextCell(1)(state, dispatch);
      return true;
    }
    const item = state.schema.nodes['list_item'];
    if (item && ancestorOf(state, ITEM) >= 0) {
      sinkListItem(item)(state, dispatch);
      return true; // a first item has nothing to sink under: the key is not the browser's either
    }
    const { selection } = state;
    const { $from } = selection;
    // not at the start of a line (a tab there is no indent in Markdown: the block's first one, or the one
    // after a forced line break), and never over a selection
    const lineStart = $from.parentOffset === 0 || $from.nodeBefore?.type.name === 'hardbreak';
    if (dispatch && selection.empty && $from.parent.isTextblock && !lineStart) {
      dispatch(state.tr.insertText('\t').scrollIntoView());
    }
    return true;
  };

/** Shift+Tab: the nested item goes out one level; elsewhere the tab before the caret goes. */
export const outdentCommand =
  (readOnly: () => boolean): Command =>
  (state, dispatch) => {
    if (readOnly()) return true; // (the indent plugin of Crepe is after this one: it would write)
    if (ancestorOf(state, CODE) >= 0) return true;
    if (ancestorOf(state, CELL) >= 0) {
      goToNextCell(-1)(state, dispatch);
      return true;
    }
    const item = state.schema.nodes['list_item'];
    const at = ancestorOf(state, ITEM);
    if (item && at >= 0) {
      // an item of the top level stays in its list (Source does not take a line out of a list either)
      const nested = at >= 2 && state.selection.$from.node(at - 2).type.name === 'list_item';
      if (nested) liftListItem(item)(state, dispatch);
      return true;
    }
    const { selection } = state;
    const { $from } = selection;
    if (dispatch && selection.empty && $from.parent.isTextblock && $from.parentOffset > 0) {
      const before = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset);
      if (before === '\t') {
        dispatch(state.tr.delete($from.pos - 1, $from.pos).scrollIntoView());
      }
    }
    return true;
  };

export const tabKeys = (readOnly: () => boolean) =>
  $prose(() =>
    keymap({
      Tab: indentCommand(readOnly),
      'Shift-Tab': outdentCommand(readOnly),
    }),
  );
