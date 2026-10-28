import { describe, expect, it } from 'vitest';
import { applyPatch } from './apply';
import { keyhole, ringArea, shapeRing } from './boolean';
import { actionById } from './registry';
import type { SceneElement } from './types';

const el = (
  id: string,
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Record<string, unknown> = {},
): SceneElement => ({ id, type, x, y, width: w, height: h, version: 1, versionNonce: 1, ...extra });

const run = (id: string, elements: SceneElement[], selected: string[], params = {}) =>
  actionById(id)!.run({ elements, selected, params });

/** Absolute area of a closed line element (points relative to x, y). */
const lineArea = (e: SceneElement): number => {
  const pts = (e.points as [number, number][]).slice(0, -1);
  return Math.abs(ringArea(pts));
};

const A = el('a', 'rectangle', 0, 0, 100, 100, {
  backgroundColor: '#ffc9c9',
  strokeColor: '#e03131',
});
const B = el('b', 'rectangle', 50, 50, 100, 100, { backgroundColor: '#a5d8ff' });

describe('shapeRing', () => {
  it('builds rings for shapes and applies rotation', () => {
    expect(Math.abs(ringArea(shapeRing(A)!))).toBe(10000);
    const diamond = shapeRing(el('d', 'diamond', 0, 0, 100, 100))!;
    expect(Math.abs(ringArea(diamond))).toBeCloseTo(5000, 6);
    const ellipse = shapeRing(el('e', 'ellipse', 0, 0, 100, 100))!;
    expect(Math.abs(ringArea(ellipse))).toBeGreaterThan(Math.PI * 2500 * 0.99);
    const rot = shapeRing(el('r', 'rectangle', 0, 0, 100, 20, { angle: Math.PI / 2 }))!;
    const xs = rot.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 6);
  });

  it('has no ring for text, arrows and open lines', () => {
    expect(shapeRing(el('t', 'text', 0, 0, 10, 10))).toBeNull();
    expect(
      shapeRing(
        el('a', 'arrow', 0, 0, 10, 10, {
          points: [
            [0, 0],
            [10, 10],
          ],
        }),
      ),
    ).toBeNull();
    expect(
      shapeRing(
        el('l', 'line', 0, 0, 10, 10, {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
        }),
      ),
    ).toBeNull();
    expect(
      shapeRing(
        el('c', 'line', 0, 0, 10, 10, {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
        }),
      ),
    ).toHaveLength(3); // a closed triangle (the last point repeats the first) has an area
    expect(
      shapeRing(
        el('c', 'line', 0, 0, 10, 10, {
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        }),
      ),
    ).toHaveLength(4);
  });
});

describe('boolean operations', () => {
  it('union: area is A + B - overlap, one closed line with the bottom style', () => {
    const patch = run('boolean-union', [A, B], ['a', 'b']);
    expect(patch.add).toHaveLength(1);
    const u = patch.add![0]!;
    expect(u.type).toBe('line');
    expect(lineArea(u)).toBeCloseTo(10000 + 10000 - 2500, 4);
    expect(u).toMatchObject({ backgroundColor: '#ffc9c9', strokeColor: '#e03131' });
    expect(patch.remove).toEqual(['a', 'b']);
    const pts = u.points as [number, number][];
    expect(pts[0]).toEqual(pts[pts.length - 1]); // closed
  });

  it('intersection keeps only the overlap', () => {
    const u = run('boolean-intersection', [A, B], ['a', 'b']).add![0]!;
    expect(lineArea(u)).toBeCloseTo(2500, 4);
    expect([u.x, u.y, u.width, u.height]).toEqual([50, 50, 50, 50]);
  });

  it('difference subtracts the others from the bottom-most shape', () => {
    const u = run('boolean-difference', [A, B], ['b', 'a']).add![0]!; // selection order is irrelevant
    expect(lineArea(u)).toBeCloseTo(10000 - 2500, 4);
    expect(u).toMatchObject({ backgroundColor: '#ffc9c9' });
  });

  it('xor gives the two non-overlapping parts', () => {
    const patch = run('boolean-xor', [A, B], ['a', 'b']);
    const total = patch.add!.reduce((s, e) => s + lineArea(e), 0);
    expect(total).toBeCloseTo(20000 - 2 * 2500, 4);
  });

  it('a disjoint intersection changes nothing', () => {
    const far = el('f', 'rectangle', 500, 500, 10, 10);
    expect(run('boolean-intersection', [A, far], ['a', 'f'])).toEqual({});
  });

  it('a hole becomes a keyhole ring whose area is outer minus hole', () => {
    const inner = el('i', 'rectangle', 25, 25, 50, 50);
    const u = run('boolean-difference', [A, inner], ['a', 'i']).add![0]!;
    expect(run('boolean-difference', [A, inner], ['a', 'i']).add).toHaveLength(1);
    expect(lineArea(u)).toBeCloseTo(10000 - 2500, 4);
  });

  it('ignores text and arrows in the selection', () => {
    const t = el('t', 'text', 0, 0, 10, 10);
    const patch = run('boolean-union', [A, B, t], ['a', 'b', 't']);
    expect(patch.remove).toEqual(['a', 'b']);
  });

  it('applies: originals are marked deleted, the result joins the scene', () => {
    const patch = run('boolean-union', [A, B], ['a', 'b']);
    const after = applyPatch([A, B], patch, () => 1, 1);
    expect(after.filter((e) => !e.isDeleted).map((e) => e.type)).toEqual(['line']);
  });
});

describe('split-ellipse', () => {
  const E = el('e', 'ellipse', 0, 0, 200, 100, { backgroundColor: '#b2f2bb' });

  it('cuts an ellipse into two halves of equal area', () => {
    const patch = run('split-ellipse', [E], ['e'], { angle: 0 });
    expect(patch.add).toHaveLength(2);
    const [a, b] = patch.add!;
    expect(lineArea(a!)).toBeCloseTo(lineArea(b!), 3);
    expect(lineArea(a!) + lineArea(b!)).toBeCloseTo(Math.abs(ringArea(shapeRing(E)!)), 3);
    expect(Number(a!.height)).toBeCloseTo(50, 6); // horizontal cut: halves are 50 tall
    expect(patch.remove).toEqual(['e']);
    expect(a).toMatchObject({ backgroundColor: '#b2f2bb' });
  });

  it('cuts along a different angle', () => {
    const patch = run('split-ellipse', [E], ['e'], { angle: 90 });
    expect(patch.add).toHaveLength(2);
    expect(Number(patch.add![0]!.width)).toBeCloseTo(100, 6);
  });

  it('ignores non-ellipses', () => {
    expect(run('split-ellipse', [A], ['a'])).toEqual({});
  });
});

describe('keyhole', () => {
  it('joins a hole to the outline', () => {
    const outer: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const hole: [number, number][] = [
      [4, 4],
      [4, 6],
      [6, 6],
      [6, 4],
    ];
    const ring = keyhole([outer, hole]);
    expect(ring).toHaveLength(outer.length + hole.length + 2);
    expect(Math.abs(ringArea(ring))).toBeCloseTo(
      Math.abs(ringArea(outer)) - Math.abs(ringArea(hole)),
      6,
    );
  });
});
