// What the Slideshow tab does to the presentation's editor (ADR-0048). Every edit is one
// CodeMirror transaction (one undo step), refused when the vault is read-only or when the text
// moved on since the slides were worked out from it.
import type { ChangeSpec } from '@codemirror/state';
import { getEditor } from '../editor/registry';
import { useMarpDeck } from './deckStore';

/** Moves the cursor to a 0-based line of the source and brings it into view. */
export function goToSlide(line: number): void {
  const view = getEditor(useMarpDeck.getState().paneId);
  if (!view) return;
  const at = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(0, line) + 1)).from;
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  view.focus();
}

/** `false`: not applied; `'noop'`: applied, the text stays what it was; `'changed'`: the text changed. */
export type EditResult = false | 'noop' | 'changed';

/**
 * Applies changes computed against `source`. Returns false when it could not be applied: the editor is
 * gone or read-only, or its text is no longer `source`. When the changes leave the text as it was (an
 * empty list, or a note rewritten as it already is) nothing is dispatched and the result is `'noop'`:
 * no sidebar will update, so the caller must not wait for it.
 */
export function applyEdit(source: string, changes: ChangeSpec[]): EditResult {
  const st = useMarpDeck.getState();
  const view = getEditor(st.paneId);
  if (!view || st.readOnly) return false;
  if (view.state.doc.toString() !== source) return false;
  if (changes.length === 0) return 'noop';
  const tr = view.state.update({ changes, userEvent: 'input.slides' });
  if (tr.newDoc.eq(view.state.doc)) return 'noop';
  view.dispatch(tr);
  // The sidebars follow after a pause; the panel needs the new text now to compute the next edit.
  useMarpDeck.setState({ source: view.state.doc.toString() });
  return 'changed';
}
