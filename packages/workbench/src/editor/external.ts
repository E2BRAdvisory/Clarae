// Applying a new version of the document that arrived from outside the editor (a sync, an external
// edit, "Reload" in the conflict banner). It is not an edit of the user: it never enters the undo
// history, so Undo cannot silently revert it and get the old text written back (D-04).
import { Annotation, Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';

/** Marks transactions that replace the document from outside (reload); not user edits. */
export const External = Annotation.define<boolean>();

/**
 * The transaction that turns the editor's document into `text`, or null when it already is. Only
 * the span that differs is replaced, so the selection and the earlier undo steps of the user are
 * mapped over the change (an undo still reverts the user's own edits around it) instead of being
 * collapsed by a whole-document replacement.
 */
export function externalReplace(state: EditorState, text: string): TransactionSpec | null {
  const old = state.doc.toString();
  if (old === text) return null;
  const max = Math.min(old.length, text.length);
  let start = 0;
  while (start < max && old.charCodeAt(start) === text.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)
  )
    end++;
  return {
    changes: { from: start, to: old.length - end, insert: text.slice(start, text.length - end) },
    annotations: [External.of(true), Transaction.addToHistory.of(false)],
  };
}
