// Figures of the status bar (words, characters, selection, line and column). Counting the words of a
// long note on every keystroke and cursor move made typing lag, so the counts are kept between
// updates: the cursor position is reported at once, the word count of the document is recomputed
// only after typing pauses, and a selection is counted at once only while it is short.
import type { EditorState, Text } from '@codemirror/state';
import type { EditorStats } from './Editor';

/** Pause after the last edit before the document's words are counted again. */
export const STATS_DELAY_MS = 250;
/** Longer selections are counted with the document, after the pause. */
const SHORT_SELECTION = 10_000;

const WORD = /[\p{L}\p{N}]+/gu;

/** Words of a string, without building the list of matches. */
export function countWords(s: string): number {
  let n = 0;
  WORD.lastIndex = 0;
  while (WORD.exec(s)) n++;
  return n;
}

/** Words of a document, line by line (a word never spans a line), without joining it. */
export function countDocWords(doc: Text): number {
  let n = 0;
  for (const it = doc.iterLines(); !it.next().done;) n += countWords(it.value);
  return n;
}

export interface StatsTracker {
  /** Called on every update that changed the document or the selection. */
  update(state: EditorState, docChanged: boolean): void;
  dispose(): void;
}

export function createStatsTracker(
  emit: (stats: EditorStats) => void,
  delay: number = STATS_DELAY_MS,
): StatsTracker {
  let words = -1; // unknown until counted
  let selWords = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: EditorState | null = null;

  const report = (state: EditorState): void => {
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    emit({
      words: Math.max(words, 0),
      chars: state.doc.length,
      selWords: sel.empty ? 0 : selWords,
      selChars: sel.to - sel.from,
      line: line.number,
      col: sel.head - line.from + 1,
    });
  };

  const settle = (): void => {
    timer = undefined;
    const state = pending;
    pending = null;
    if (!state) return;
    words = countDocWords(state.doc);
    const sel = state.selection.main;
    selWords = sel.empty ? 0 : countWords(state.sliceDoc(sel.from, sel.to));
    report(state);
  };

  return {
    update(state, docChanged) {
      const sel = state.selection.main;
      const short = sel.to - sel.from <= SHORT_SELECTION;
      if (short) selWords = sel.empty ? 0 : countWords(state.sliceDoc(sel.from, sel.to));
      if (words < 0)
        words = countDocWords(state.doc); // first report: count once, now
      else if (docChanged || !short) {
        pending = state;
        clearTimeout(timer);
        timer = setTimeout(settle, delay);
      }
      report(state);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}
