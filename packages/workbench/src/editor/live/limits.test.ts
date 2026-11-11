import { describe, expect, it } from 'vitest';
import { LIVE_MAX, liveLimit, measure } from './limits';

describe('measure', () => {
  it('counts blocks, the longest one and the code blocks', () => {
    const raw =
      '# Title\n\npara one\nsecond line\n\n- a\n- b\n  - c\n\n```ts\ncode\n\nmore code\n```\n\nlast\n';
    const m = measure(raw);
    expect(m.chars).toBe(raw.length);
    // title, paragraph, three items, the fence (a blank line inside it does not end it), last
    expect(m).toMatchObject({ blocks: 7, codeBlocks: 1 });
    expect(m.block).toBe('```ts\ncode\n\nmore code\n```'.length);
  });

  it('knows a fence by its marker and its length (a shorter one inside does not close it)', () => {
    const m = measure('````\n```\ninside\n```\n````\n\n~~~\nx\n~~~\n');
    expect(m.codeBlocks).toBe(2);
    expect(m.blocks).toBe(2);
  });

  it('counts a text with no final line end, an empty one, and Windows line ends', () => {
    expect(measure('')).toMatchObject({ blocks: 0, codeBlocks: 0, block: 0 });
    expect(measure('one\n\ntwo')).toMatchObject({ blocks: 2 });
    expect(measure('one\r\n\r\ntwo\r\n')).toMatchObject({ blocks: 2 });
  });
});

describe('liveLimit', () => {
  it('lets an ordinary note open', () => {
    expect(liveLimit('# Title\n\nsome text\n\n- a\n- b\n')).toBeNull();
    expect(liveLimit('')).toBeNull();
  });

  const max = { chars: 100, blocks: 4, block: 40, codeBlocks: 1 };
  it('names the first limit a note goes over, with what it has and what the limit is', () => {
    expect(liveLimit('x'.repeat(101), max)).toEqual({ reason: 'chars', value: 101, max: 100 });
    expect(liveLimit('a\n\nb\n\nc\n\nd\n\ne\n', max)).toEqual({
      reason: 'blocks',
      value: 5,
      max: 4,
    });
    expect(liveLimit('y'.repeat(50), max)).toEqual({ reason: 'block', value: 50, max: 40 });
    expect(liveLimit('```\n```\n\n```\n```\n', max)).toEqual({
      reason: 'codeBlocks',
      value: 2,
      max: 1,
    });
  });

  it('is exact at the limit: a note that has as many as the limit allows opens', () => {
    expect(liveLimit('a\n\nb\n\nc\n\nd\n', max)).toBeNull();
    expect(liveLimit('x'.repeat(40), max)).toBeNull();
  });

  it('has limits the measurements of A-W4 justify', () => {
    expect(LIVE_MAX).toEqual({ chars: 250_000, blocks: 3_000, block: 20_000, codeBlocks: 150 });
    // a note of 3 000 blocks opens; one of 3 001 does not
    const notes = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`).join('\n\n');
    expect(liveLimit(notes(3000))).toBeNull();
    expect(liveLimit(notes(3001))).toMatchObject({ reason: 'blocks' });
  });
});
