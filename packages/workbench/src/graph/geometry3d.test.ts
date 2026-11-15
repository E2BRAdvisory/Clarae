import { describe, expect, it } from 'vitest';
import {
  ARC_SEGMENTS,
  boundsOf,
  fitDistance,
  planLinks,
  reciprocalEdges,
  writeLinks,
} from './geometry3d';

const point = (a: Float32Array, vertex: number): [number, number, number] => [
  a[3 * vertex] as number,
  a[3 * vertex + 1] as number,
  a[3 * vertex + 2] as number,
];

describe('links of the 3D graph', () => {
  // 0 ⇄ 1, 1 → 2, and a self link that is nobody's opposite
  const edges = Int32Array.of(0, 1, 1, 0, 1, 2, 2, 2);

  it('finds the links whose opposite exists', () => {
    expect(Array.from(reciprocalEdges(edges, 3))).toEqual([1, 1, 0, 0]);
  });

  it('puts every link in one buffer: two vertices when straight, an arc when reciprocal', () => {
    const plan = planLinks(edges, 3, true);
    expect(Array.from(plan.first)).toEqual([
      0,
      2 * ARC_SEGMENTS,
      4 * ARC_SEGMENTS,
      4 * ARC_SEGMENTS + 2,
    ]);
    expect(plan.vertices).toBe(4 * ARC_SEGMENTS + 4);
    // Without curves every link is a segment.
    const flat = planLinks(edges, 3, false);
    expect(Array.from(flat.curved)).toEqual([0, 0, 0, 0]);
    expect(flat.vertices).toBe(8);
  });

  it('draws a straight link between its ends and the two arcs of a pair on opposite sides', () => {
    const plan = planLinks(edges, 3, true);
    const pos = Float32Array.of(0, 0, 0, 100, 0, 0, 100, 50, 0);
    const out = new Float32Array(plan.vertices * 3);
    writeLinks(out, plan, pos, null);
    // 1 → 2, straight
    const straight = plan.first[2] as number;
    expect(point(out, straight)).toEqual([100, 0, 0]);
    expect(point(out, straight + 1)).toEqual([100, 50, 0]);
    // 0 → 1: starts at 0, ends at 1, each segment starting where the one before ended
    const there = plan.first[0] as number;
    expect(point(out, there)).toEqual([0, 0, 0]);
    expect(point(out, there + 2 * ARC_SEGMENTS - 1)).toEqual([100, 0, 0]);
    for (let j = 1; j < ARC_SEGMENTS; j++)
      expect(point(out, there + 2 * j)).toEqual(point(out, there + 2 * j - 1));
    // The middle of each arc is off the line, the two on opposite sides of it.
    const back = plan.first[1] as number;
    const midThere = point(out, there + ARC_SEGMENTS);
    const midBack = point(out, back + ARC_SEGMENTS);
    expect(midThere[0]).toBeCloseTo(50);
    expect(midBack[0]).toBeCloseTo(50);
    expect(Math.abs(midThere[2])).toBeGreaterThan(5);
    expect(midBack[2]).toBeCloseTo(-midThere[2]);
  });

  it('bends a vertical pair too (the sideways axis changes)', () => {
    const plan = planLinks(Int32Array.of(0, 1, 1, 0), 2, true);
    const out = new Float32Array(plan.vertices * 3);
    writeLinks(out, plan, Float32Array.of(0, 0, 0, 0, 80, 0), null);
    const mid = point(out, ARC_SEGMENTS);
    expect(Math.hypot(mid[0], mid[2])).toBeGreaterThan(5);
    expect(out.every(Number.isFinite)).toBe(true);
  });

  it('collapses the links of a hidden node, and those of a node not placed yet', () => {
    const plan = planLinks(edges, 3, true);
    const pos = Float32Array.of(0, 0, 0, 100, 0, 0, 100, 50, 0);
    const out = new Float32Array(plan.vertices * 3).fill(7);
    writeLinks(out, plan, pos, Uint8Array.of(1, 1, 0));
    const hidden = plan.first[2] as number;
    expect(point(out, hidden)).toEqual([0, 0, 0]);
    expect(point(out, hidden + 1)).toEqual([0, 0, 0]);
    expect(point(out, (plan.first[0] as number) + 2 * ARC_SEGMENTS - 1)).toEqual([100, 0, 0]);
    // Positions for two nodes only: the link to the third draws nothing, nothing is read past the end.
    out.fill(7);
    writeLinks(out, plan, pos.subarray(0, 6), null);
    expect(point(out, hidden + 1)).toEqual([0, 0, 0]);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe('framing of the 3D graph', () => {
  it('finds the sphere around the nodes shown', () => {
    const pos = Float32Array.of(-10, 0, 0, 10, 0, 0, 0, 40, 0);
    expect(boundsOf(pos, 3, null)).toEqual({ x: 0, y: 20, z: 0, r: Math.hypot(10, 20) });
    // The timelapse hides the third node: the sphere shrinks to the other two.
    expect(boundsOf(pos, 3, Uint8Array.of(1, 1, 0))).toEqual({ x: 0, y: 0, z: 0, r: 10 });
    expect(boundsOf(pos, 3, Uint8Array.of(0, 0, 0))).toBeNull();
    expect(boundsOf(new Float32Array(0), 3, null)).toBeNull();
  });

  it('stands far enough to show the sphere in the narrower direction', () => {
    const wide = fitDistance(100, 50, 2, 1);
    expect(wide).toBeCloseTo(100 / Math.sin((25 * Math.PI) / 180));
    // A tall surface is narrower sideways: the camera stands farther.
    expect(fitDistance(100, 50, 0.5, 1)).toBeGreaterThan(wide);
    // A single node is not looked at from its surface.
    expect(fitDistance(0, 50, 1, 1)).toBeGreaterThan(50);
  });
});
