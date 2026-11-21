import { describe, expect, it } from 'vitest';
import { getUserColor, hashOf, PALETTE_SIZE } from './colors';

describe('getUserColor', () => {
  it('is the same colour for the same user, always', () => {
    const id = '0194f6a0-7b1c-7c5e-9a53-3f2f1d2a9c11';
    expect(getUserColor(id)).toEqual(getUserColor(id));
    // a fixed value: the colour of a person must not change from one release to the next
    expect(hashOf('user-1')).toBe(4_115_888_500);
    expect(['user-1', 'user-2', 'alice'].map((u) => getUserColor(u).index)).toEqual([5, 6, 8]);
  });

  it('always lands in the palette, with the token pair of its index', () => {
    for (let i = 0; i < 500; i++) {
      const c = getUserColor(`user-${i}`);
      expect(c.index).toBeGreaterThanOrEqual(1);
      expect(c.index).toBeLessThanOrEqual(PALETTE_SIZE);
      expect(c.background).toBe(`var(--presence-${c.index})`);
      expect(c.foreground).toBe(`var(--presence-${c.index}-fg)`);
    }
  });

  it('spreads users over the whole palette', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(getUserColor(`u${i}`).index);
    expect(seen.size).toBe(PALETTE_SIZE);
  });

  it('never uses Math.random', () => {
    const real = Math.random;
    Math.random = () => {
      throw new Error('Math.random');
    };
    try {
      expect(() => getUserColor('anyone')).not.toThrow();
    } finally {
      Math.random = real;
    }
  });
});
