import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { countDocWords, countWords, createStatsTracker } from './stats';
import type { EditorStats } from './Editor';

afterEach(() => vi.useRealTimers());

describe('word counts', () => {
  it('counts letters and digits in any script, line by line', () => {
    expect(countWords('Ciao, mondo! 42 è più')).toBe(5);
    expect(countDocWords(EditorState.create({ doc: 'one two\nthree\n\nfour' }).doc)).toBe(4);
  });
});

describe('createStatsTracker', () => {
  it('reports the cursor at once and recounts the words only after typing pauses', () => {
    vi.useFakeTimers();
    const seen: EditorStats[] = [];
    const tracker = createStatsTracker((s) => seen.push(s), 250);
    let state = EditorState.create({ doc: 'alpha beta' });
    tracker.update(state, true);
    expect(seen.at(-1)).toMatchObject({ words: 2, chars: 10, line: 1, col: 1 });

    state = state.update({
      changes: { from: 10, insert: ' gamma' },
      selection: { anchor: 16 },
    }).state;
    tracker.update(state, true);
    expect(seen.at(-1)).toMatchObject({ words: 2, chars: 16, col: 17 }); // not recounted yet
    vi.advanceTimersByTime(250);
    expect(seen.at(-1)).toMatchObject({ words: 3, chars: 16 });

    state = state.update({ selection: EditorSelection.range(0, 10) }).state;
    tracker.update(state, false);
    expect(seen.at(-1)).toMatchObject({ selWords: 2, selChars: 10 });
    tracker.dispose();
  });

  it('counts a long selection after the pause', () => {
    vi.useFakeTimers();
    const seen: EditorStats[] = [];
    const doc = 'word '.repeat(5000);
    const tracker = createStatsTracker((s) => seen.push(s), 250);
    let state = EditorState.create({ doc });
    tracker.update(state, true);
    state = state.update({ selection: EditorSelection.range(0, doc.length) }).state;
    tracker.update(state, false);
    expect(seen.at(-1)?.selChars).toBe(doc.length);
    vi.advanceTimersByTime(250);
    expect(seen.at(-1)?.selWords).toBe(5000);
  });
});
