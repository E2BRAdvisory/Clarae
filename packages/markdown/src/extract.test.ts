import { describe, expect, it } from 'vitest';
import { maskBlocks, scanSpans, type BlockState } from './inline';

describe('scanSpans / maskBlocks', () => {
  it('finds comment and math spans on one line', () => {
    const st: BlockState = { inMath: false, inComment: false };
    expect(scanSpans('a %%c%% b $$m$$ c', st)).toEqual([
      { kind: 'comment', from: 2, to: 7, continued: false, closed: true },
      { kind: 'math', from: 10, to: 15, continued: false, closed: true },
    ]);
    expect(st).toEqual({ inMath: false, inComment: false });
  });

  it('carries unclosed blocks to the next lines and closes them', () => {
    const st: BlockState = { inMath: false, inComment: false };
    expect(scanSpans('x %% open', st)).toEqual([
      { kind: 'comment', from: 2, to: 9, continued: false, closed: false },
    ]);
    expect(st.inComment).toBe(true);
    expect(scanSpans('still inside', st)).toEqual([
      { kind: 'comment', from: 0, to: 12, continued: true, closed: false },
    ]);
    expect(scanSpans('end %% after', st)).toEqual([
      { kind: 'comment', from: 0, to: 6, continued: true, closed: true },
    ]);
    expect(st.inComment).toBe(false);
  });

  it('masks while keeping columns', () => {
    const st: BlockState = { inMath: false, inComment: false };
    const out = maskBlocks('keep %%hide%% keep', st);
    expect(out).toBe('keep          keep');
    expect(out.length).toBe('keep %%hide%% keep'.length);
  });
});
