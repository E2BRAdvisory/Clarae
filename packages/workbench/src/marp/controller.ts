// What the Slideshow tab does to the presentation's editor (ADR-0048). Every edit is one
// change of the editor (one undo step), refused when the vault is read-only or when the text
// moved on since the slides were worked out from it.
import type { EditResult } from '../editor/handle';
import { getEditor } from '../editor/registry';
import type { SourceEdit } from '../editor/types';
import { useMarpDeck } from './deckStore';

/** Moves the cursor to a 0-based line of the source and brings it into view. */
export function goToSlide(line: number): void {
  getEditor(useMarpDeck.getState().paneId)?.gotoLine(Math.max(0, line) + 1);
}

export type { EditResult };

/**
 * Applies changes computed against `source`. Returns false when it could not be applied: the editor is
 * gone or read-only, or its text is no longer `source`. When the changes leave the text as it was (an
 * empty list, or a note rewritten as it already is) nothing is dispatched and the result is `'noop'`:
 * no sidebar will update, so the caller must not wait for it.
 */
export function applyEdit(source: string, changes: SourceEdit[]): EditResult {
  const st = useMarpDeck.getState();
  const view = getEditor(st.paneId);
  if (!view || st.readOnly) return false;
  const result = view.applySourceEdits(source, changes, 'input.slides');
  // The sidebars follow after a pause; the panel needs the new text now to compute the next edit.
  if (result === 'changed') useMarpDeck.setState({ source: view.text() });
  return result;
}
