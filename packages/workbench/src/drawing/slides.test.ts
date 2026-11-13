import { describe, expect, it } from 'vitest';
import type { SceneElement } from './actions/types';
import { moveSlide, playable, reorderUpdate, slideKey, slideMetaUpdate, slidesOf } from './slides';

const frame = (
  id: string,
  name: string | null,
  x: number,
  y: number,
  extra = {},
): SceneElement => ({
  id,
  type: 'frame',
  name,
  x,
  y,
  version: 1,
  versionNonce: 1,
  ...extra,
});

describe('slidesOf', () => {
  it('orders named frames naturally and ignores deleted ones and other elements', () => {
    const els = [
      frame('c', 'Slide 10', 0, 0),
      frame('a', 'Slide 2', 0, 0),
      frame('b', 'slide 1', 0, 0),
      frame('d', 'Slide 3', 0, 0, { isDeleted: true }),
      { id: 'r', type: 'rectangle', version: 1, versionNonce: 1 },
    ];
    expect(slidesOf(els).map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('falls back to reading order for unnamed frames', () => {
    const els = [frame('c', null, 0, 500), frame('b', null, 400, 0), frame('a', null, 0, 0)];
    expect(slidesOf(els)).toEqual([
      { id: 'a', name: 'Frame 1', notes: '', included: true, version: 1 },
      { id: 'b', name: 'Frame 2', notes: '', included: true, version: 1 },
      { id: 'c', name: 'Frame 3', notes: '', included: true, version: 1 },
    ]);
  });

  it('carries the presenter notes of a frame', () => {
    const els = [frame('a', 'A', 0, 0, { customData: { clarae: { notes: 'say hello' } } })];
    expect(slidesOf(els)[0]?.notes).toBe('say hello');
  });

  it('puts explicitly numbered slides first, in that order', () => {
    const els = [
      frame('x', 'A', 0, 0),
      frame('b', 'Z', 0, 0, { customData: { clarae: { slide: 2 } } }),
      frame('a', 'Y', 0, 0, { customData: { clarae: { slide: 1 } } }),
    ];
    expect(slidesOf(els).map((s) => s.id)).toEqual(['a', 'b', 'x']);
  });
});

describe('navigation', () => {
  it('clamps at both ends', () => {
    expect(moveSlide(0, -1, 3)).toBe(0);
    expect(moveSlide(2, 1, 3)).toBe(2);
    expect(moveSlide(1, 1, 3)).toBe(2);
  });

  it('maps keys', () => {
    expect(slideKey('ArrowRight')).toBe(1);
    expect(slideKey('PageUp')).toBe(-1);
    expect(slideKey('Home')).toBe('first');
    expect(slideKey('End')).toBe('last');
    expect(slideKey('a')).toBeUndefined();
  });
});

describe('slide panel helpers', () => {
  it('keeps the other custom data when it sets or clears a key', () => {
    const f = frame('a', 'A', 0, 0, { customData: { other: 1, clarae: { notes: 'n' } } });
    expect(slideMetaUpdate(f, { slideHidden: true })).toEqual({
      customData: { other: 1, clarae: { notes: 'n', slideHidden: true } },
    });
    expect(slideMetaUpdate(f, { notes: '' })).toEqual({
      customData: { other: 1, clarae: {} },
    });
  });

  it('numbers frames in the new order and flags the hidden ones', () => {
    const els = [
      frame('a', 'A', 0, 0),
      frame('b', 'B', 0, 0, { customData: { clarae: { slide: 2, slideHidden: true } } }),
    ];
    const upd = reorderUpdate(els, ['b', 'a']);
    expect(Object.keys(upd).sort()).toEqual(['a', 'b']);
    expect(upd['a']).toEqual({ customData: { clarae: { slide: 2 } } });
    expect(upd['b']).toEqual({ customData: { clarae: { slide: 1, slideHidden: true } } });
    expect(playable(slidesOf(els)).map((s) => s.id)).toEqual(['a']);
  });
});
