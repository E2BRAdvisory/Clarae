import { describe, expect, it } from 'vitest';
import { WARM_ALPHA } from './layoutEngine';
import { LayoutEngine3D } from './layoutEngine3d';
import { startLayout } from './layoutHost';
import { defaultForces } from './types';

const at = (p: Float32Array, i: number): [number, number, number] => [
  p[3 * i] as number,
  p[3 * i + 1] as number,
  p[3 * i + 2] as number,
];
const dist = (p: Float32Array, a: number, b: number): number =>
  Math.hypot(
    (p[3 * a] as number) - (p[3 * b] as number),
    (p[3 * a + 1] as number) - (p[3 * b + 1] as number),
    (p[3 * a + 2] as number) - (p[3 * b + 2] as number),
  );
const settle = (e: LayoutEngine3D): Float32Array => {
  while (!e.settled) e.tick(1);
  return e.snapshot();
};

// Two triangles, no link between them, and an edge that points outside the graph.
const EDGES = Int32Array.of(0, 1, 1, 2, 2, 0, 3, 4, 4, 5, 5, 3, 0, 99);

describe('layout engine in three dimensions', () => {
  it('lays the graph out in space: links near their rest length, no two nodes together, all three axes used', () => {
    const e = new LayoutEngine3D(6, EDGES, defaultForces);
    const p = settle(e);
    expect(p).toHaveLength(18);
    expect(p.every(Number.isFinite)).toBe(true);
    // The two triangles may sit inside each other (in space they can), so a link is judged by
    // its own length, not against the distance between components.
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
      [3, 4],
      [4, 5],
      [5, 3],
    ] as const) {
      expect(dist(p, a, b)).toBeGreaterThan(defaultForces.linkDistance / 2);
      expect(dist(p, a, b)).toBeLessThan(defaultForces.linkDistance * 2);
    }
    for (let a = 0; a < 6; a++)
      for (let b = a + 1; b < 6; b++) expect(dist(p, a, b)).toBeGreaterThan(5);
    for (const axis of [0, 1, 2]) {
      const values = Array.from({ length: 6 }, (_, i) => p[3 * i + axis] as number);
      expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(1);
    }
  });

  it('continues from known positions and barely moves a settled graph', () => {
    const cold = new LayoutEngine3D(6, EDGES, defaultForces);
    const settled = settle(cold);
    const warm = new LayoutEngine3D(6, EDGES, defaultForces, {
      positions: settled,
      alpha: WARM_ALPHA,
    });
    expect(Array.from(warm.snapshot())).toEqual(Array.from(settled));
    const after = settle(warm);
    expect(warm.tickCount).toBeLessThan(cold.tickCount);
    for (let i = 0; i < 6; i++) {
      expect(
        Math.hypot(...at(after, i).map((v, d) => v - (settled[3 * i + d] as number))),
      ).toBeLessThan(15);
    }
  });

  it('holds a node where it was put while the others arrange around it, until it is released', () => {
    const e = new LayoutEngine3D(6, EDGES, defaultForces);
    settle(e);
    e.fix(0, 300, -200, 150);
    expect(e.settled).toBe(false); // the layout warmed up for the neighbours to follow
    const held = settle(e);
    expect(at(held, 0)).toEqual([300, -200, 150]);
    // Its neighbours followed it; the other triangle did not.
    expect(dist(held, 0, 1)).toBeLessThan(120);
    expect(dist(held, 0, 4)).toBeGreaterThan(150);
    e.release(0);
    const free = settle(e);
    expect(Math.hypot(...at(free, 0))).toBeLessThan(Math.hypot(300, 200, 150));
    // Releasing everything, and an index outside the graph, are harmless.
    e.fix(99, 0, 0, 0);
    e.release();
    expect(settle(e).every(Number.isFinite)).toBe(true);
  });

  it('reheats when forces change', () => {
    const e = new LayoutEngine3D(6, EDGES, defaultForces);
    const near = settle(e);
    e.setForces({ ...defaultForces, linkDistance: 200 });
    expect(e.settled).toBe(false);
    const far = settle(e);
    expect(dist(far, 0, 1)).toBeGreaterThan(dist(near, 0, 1));
  });
});

describe('layout host in three dimensions', () => {
  it('posts x,y,z triples and holds a dragged node (inline engine: no Worker here)', async () => {
    let last: Float32Array = new Float32Array(0);
    const done = new Promise<void>((resolve) => {
      const host = startLayout(
        6,
        EDGES,
        defaultForces,
        (p, _alpha, settled) => {
          last = p;
          if (settled) resolve();
        },
        undefined,
        3,
      );
      host.fix(2, 50, 60, 70);
    });
    await done;
    expect(last).toHaveLength(18);
    expect(at(last, 2)).toEqual([50, 60, 70]);
  });

  it('ignores fix and release on a 2D layout', async () => {
    let last: Float32Array = new Float32Array(0);
    await new Promise<void>((resolve) => {
      const host = startLayout(3, Int32Array.of(0, 1, 1, 2), defaultForces, (p, _a, settled) => {
        last = p;
        if (settled) resolve();
      });
      host.fix(0, 500, 500, 500);
      host.release();
    });
    expect(last).toHaveLength(6);
    expect(Math.abs(last[0] as number)).toBeLessThan(400);
  });
});
