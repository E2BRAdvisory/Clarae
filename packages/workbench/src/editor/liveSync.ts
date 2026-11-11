// The user event of the transaction that brings the Live editor's text into the CodeMirror editor when
// the mode changes (ADR-0049, A-D9): it is no edit to report (the note was reported as Live changed it)
// and it is one step of the CodeMirror history. Here, and not in Editor.tsx, so that the module that
// chooses between the engines can name it without loading CodeMirror.
export const LIVE_SYNC_EVENT = 'live.sync';

/** The one change that turns `base` into `target`: what they do not share at the start and at the end. */
export function singleEdit(
  base: string,
  target: string,
): { from: number; to: number; insert: string } {
  const max = Math.min(base.length, target.length);
  let from = 0;
  while (from < max && base.charCodeAt(from) === target.charCodeAt(from)) from++;
  let end = 0;
  while (
    end < max - from &&
    base.charCodeAt(base.length - 1 - end) === target.charCodeAt(target.length - 1 - end)
  )
    end++;
  return { from, to: base.length - end, insert: target.slice(from, target.length - end) };
}
