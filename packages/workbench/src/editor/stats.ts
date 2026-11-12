// Figures of the editor (words, characters, selection, line and column) for the Statistics panel
// and the status bar (ADR-0035): the engine independent part. The CodeMirror one (the figures of a
// state, the tracker that keeps the counts between updates) is in source/stats.ts.
/** Pause after the last edit before the document's words are counted again. */
export const STATS_DELAY_MS = 250;
const WORD = /[\p{L}\p{N}]+/gu;

/** Words of a string, without building the list of matches. */
export function countWords(s: string): number {
  let n = 0;
  WORD.lastIndex = 0;
  while (WORD.exec(s)) n++;
  return n;
}
