import { describe, expect, it } from 'vitest';
import { parseDrawingRef, refElements, refKey } from './ref';

describe('parseDrawingRef', () => {
  it('reads heading and block-reference forms', () => {
    expect(parseDrawingRef('frame=Intro', '')).toEqual({ kind: 'frame', value: 'Intro' });
    expect(parseDrawingRef('', 'clippedframe=My slide')).toEqual({
      kind: 'clippedframe',
      value: 'My slide',
    });
    expect(parseDrawingRef('Group=abc', '')).toEqual({ kind: 'group', value: 'abc' });
    expect(parseDrawingRef('area=x1', '')).toEqual({ kind: 'area', value: 'x1' });
  });

  it('ignores plain headings and unknown or empty parts', () => {
    expect(parseDrawingRef('', '')).toBeNull();
    expect(parseDrawingRef('Heading', '')).toBeNull();
    expect(parseDrawingRef('color=red', '')).toBeNull();
    expect(parseDrawingRef('frame=', '')).toBeNull();
    expect(parseDrawingRef('=x', '')).toBeNull();
  });

  it('builds a cache key', () => {
    expect(refKey(null)).toBe('');
    expect(refKey({ kind: 'frame', value: 'A' })).toBe('frame=A');
  });
});

describe('refElements', () => {
  const el = (id: string, type: string, x: number, y: number, extra = {}) => ({
    id,
    type,
    x,
    y,
    width: 100,
    height: 100,
    ...extra,
  });
  const els = [
    el('f', 'frame', 0, 0, { name: 'Intro' }),
    el('a', 'rectangle', 10, 10, { frameId: 'f', groupIds: ['g1'] }),
    el('b', 'rectangle', 500, 500, { groupIds: ['g1'] }),
    el('c', 'rectangle', 50, 50),
    el('gone', 'rectangle', 10, 10, { frameId: 'f', isDeleted: true }),
  ];

  it('frame is unclipped, clippedframe clips; the name is case-insensitive', () => {
    const plain = refElements(els, { kind: 'frame', value: 'intro' });
    expect(plain?.elements.map((e) => e.id)).toEqual(['f', 'a']);
    expect(plain?.frame).toBeNull();
    const clipped = refElements(els, { kind: 'clippedframe', value: 'Intro' });
    expect(clipped?.frame?.id).toBe('f');
    expect(refElements(els, { kind: 'frame', value: 'f' })?.elements).toHaveLength(2);
  });

  it('group collects its members', () => {
    expect(refElements(els, { kind: 'group', value: 'g1' })?.elements.map((e) => e.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('area takes what overlaps the element', () => {
    expect(refElements(els, { kind: 'area', value: 'f' })?.elements.map((e) => e.id)).toEqual([
      'f',
      'a',
      'c',
    ]);
  });

  it('is null when the part does not exist', () => {
    expect(refElements(els, { kind: 'frame', value: 'Nope' })).toBeNull();
    expect(refElements(els, { kind: 'group', value: 'zz' })).toBeNull();
    expect(refElements(els, { kind: 'area', value: 'zz' })).toBeNull();
    expect(refElements(els, { kind: 'frame', value: 'c' })).toBeNull(); // not a frame
  });
});
