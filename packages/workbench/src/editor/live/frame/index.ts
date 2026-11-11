// The frame of the Live editor (A-W5c): what the editor of the application has around the text (find and
// replace, folding) and the settings that tune it. Installed by the real editor only (crepe.ts); the
// headless editor of the fidelity tests has no use for it. The pieces:
//
//   find.ts        the search of the document: query, matches, decorations, replace
//   findBar.ts     the bar that drives it (translated, with regular expression and match case)
//   fold.ts        folding of headings, list items, quotes, code blocks and tables (state of the plugin)
//   foldHover.ts   the chevron an open block shows when the pointer is on its first line
//
// The toolbar above the note is not here: it is `EditorToolbar`, which works on any editor through its
// handle, and Crepe's own top bar stays off (its buttons have no accessible names and no translation).
import type { Editor } from '@milkdown/kit/core';
import { keymap } from '@milkdown/kit/prose/keymap';
import { $prose } from '@milkdown/kit/utils';
import { findKey, findNext, findPlugin } from './find';
import { foldKeys, foldPlugin } from './fold';

export { FindBar, type FindBarHost } from './findBar';
export {
  findKey,
  findMatches,
  findNext,
  findStateOf,
  replaceAll,
  replaceCurrent,
  setFind,
  type FindQuery,
  type FindState,
} from './find';
export {
  foldableAt,
  foldAll,
  foldCode,
  foldKey,
  foldStateOf,
  toggleFoldAt,
  unfoldAll,
  unfoldCode,
  type FoldKind,
} from './fold';
export { attachFoldHover, foldTargetAt } from './foldHover';

/** The editor settings the Live editor follows while it is open (the application's `EditorSettings`). */
export interface LiveSettings {
  /** The width of a tab: in the code blocks, where it is also what an indent is. */
  tabSize: number;
  spellcheck: boolean;
  /** Pixels. */
  fontSize: number;
  /** Long lines wrap (otherwise the note scrolls sideways). */
  wrap: boolean;
  /** Folding is on. */
  foldHeadings: boolean;
  /** The dark theme is the one in force: the colours of the code blocks follow it. */
  dark: boolean;
}

export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  tabSize: 4,
  spellcheck: true,
  fontSize: 15,
  wrap: true,
  foldHeadings: true,
  dark: false,
};

/** Ctrl-G (Cmd-G on the Mac) and Shift with it go through the matches of an open search. */
const searchKeys = $prose(() =>
  keymap({
    'Mod-g': (state, dispatch, view) => {
      if (!view || !findKey.getState(state)?.open) return false;
      if (dispatch) findNext(view, 1);
      return true;
    },
    'Shift-Mod-g': (state, dispatch, view) => {
      if (!view || !findKey.getState(state)?.open) return false;
      if (dispatch) findNext(view, -1);
      return true;
    },
  }),
);

export function installFrame(editor: Editor, o: { foldHeadings: boolean }): Editor {
  return editor.use(findPlugin).use(foldPlugin(o.foldHeadings)).use(foldKeys).use(searchKeys);
}
