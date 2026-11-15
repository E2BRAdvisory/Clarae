import { describe, expect, it } from 'vitest';
import { NODE_KINDS } from './kinds';
import {
  DIM_SCALE,
  groupByShape,
  INSTANCED_NODES,
  kindShape,
  lodFor,
  SHAPES,
  shownPrefix,
  SPRITE_NODES,
  writeInstanceMatrices,
  type Shape,
} from './lod';

describe('lodFor', () => {
  it('draws sprites up to SPRITE_NODES, solids up to INSTANCED_NODES, points beyond', () => {
    expect(SPRITE_NODES).toBe(1000);
    expect(INSTANCED_NODES).toBe(2000);
    expect(lodFor(0)).toBe('sprite');
    expect(lodFor(SPRITE_NODES)).toBe('sprite');
    expect(lodFor(SPRITE_NODES + 1)).toBe('instanced');
    expect(lodFor(INSTANCED_NODES)).toBe('instanced');
    expect(lodFor(INSTANCED_NODES + 1)).toBe('points');
    expect(lodFor(5000)).toBe('points');
  });

  it('is never forced in a release (the override is read in E2E builds only)', () => {
    (window as { __CLARAE_GRAPH3D_LOD__?: string }).__CLARAE_GRAPH3D_LOD__ = 'points';
    try {
      expect(lodFor(10)).toBe('sprite');
    } finally {
      delete (window as { __CLARAE_GRAPH3D_LOD__?: string }).__CLARAE_GRAPH3D_LOD__;
    }
  });
});

describe('kindShape', () => {
  it('gives every kind a shape the legend knows, and the notes a sphere', () => {
    for (const kind of NODE_KINDS) expect(SHAPES).toContain(kindShape(kind));
    expect(kindShape('note')).toBe('sphere');
    expect(kindShape('presentation')).toBe('sphere');
  });

  it('tells apart the kinds the owner named: drawings, canvases, bases, attachments, tags', () => {
    const shapes = (['drawing', 'canvas', 'base', 'image', 'tag', 'note'] as const).map(kindShape);
    expect(new Set(shapes).size).toBe(6); // note, drawing, canvas, base, attachment, tag
    // every attachment is the same solid
    const attachment = kindShape('image');
    for (const k of ['pdf', 'audio', 'video', 'other', 'webapp'] as const) {
      expect(kindShape(k)).toBe(attachment);
    }
  });
});

describe('groupByShape', () => {
  it('makes a group per shape in use, in the order of SHAPES, each oldest node first', () => {
    const shapes: Shape[] = ['cone', 'sphere', 'cube', 'sphere', 'cone', 'sphere'];
    // creation rank of each node: the last one is the oldest
    const rank = [4, 3, 0, 5, 1, 2];
    const groups = groupByShape(shapes, rank);
    expect(groups.map((g) => g.shape)).toEqual(['sphere', 'cube', 'cone']);
    expect(Array.from(groups[0]!.nodes)).toEqual([5, 1, 3]);
    expect(Array.from(groups[1]!.nodes)).toEqual([2]);
    expect(Array.from(groups[2]!.nodes)).toEqual([4, 0]);
    // every node is in exactly one group
    expect(groups.reduce((n, g) => n + g.nodes.length, 0)).toBe(shapes.length);
  });

  it('makes no group, hence no draw call, for a shape no node has', () => {
    const groups = groupByShape(['sphere', 'sphere'], [0, 1]);
    expect(groups).toHaveLength(1);
    expect(groupByShape([], [])).toEqual([]);
  });

  it('is one draw call per kind of document at most, however many nodes', () => {
    const n = 5000;
    const kinds = NODE_KINDS;
    const shapes = Array.from({ length: n }, (_, i) => kindShape(kinds[i % kinds.length]!));
    const groups = groupByShape(
      shapes,
      Array.from({ length: n }, (_, i) => i),
    );
    expect(groups.length).toBeLessThanOrEqual(kinds.length);
    expect(groups.length).toBe(new Set(kinds.map(kindShape)).size);
  });
});

describe('shownPrefix', () => {
  const nodes = Int32Array.from([4, 2, 0, 1]);
  it('shows every node without a timelapse', () => {
    expect(shownPrefix(nodes, null)).toBe(4);
  });
  it('shows up to the last visible node of the group', () => {
    const visible = Uint8Array.from([0, 0, 1, 0, 1]); // nodes 2 and 4
    expect(shownPrefix(nodes, visible)).toBe(2);
    expect(shownPrefix(nodes, new Uint8Array(5))).toBe(0);
    expect(shownPrefix(nodes, Uint8Array.from([1, 1, 1, 1, 1]))).toBe(4);
  });
});

describe('writeInstanceMatrices', () => {
  const pos = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const nodes = Int32Array.from([2, 0, 1]);
  const size = (i: number): number => 10 + i;
  const read = (out: Float32Array, k: number) => ({
    s: [out[16 * k], out[16 * k + 5], out[16 * k + 10]],
    at: [out[16 * k + 12], out[16 * k + 13], out[16 * k + 14]],
    w: out[16 * k + 15],
  });

  it('scales and translates each instance, in the order of the group', () => {
    const out = new Float32Array(16 * 3);
    writeInstanceMatrices(out, nodes, pos, null, null, size);
    expect(read(out, 0)).toEqual({ s: [12, 12, 12], at: [7, 8, 9], w: 1 });
    expect(read(out, 1)).toEqual({ s: [10, 10, 10], at: [1, 2, 3], w: 1 });
    expect(read(out, 2)).toEqual({ s: [11, 11, 11], at: [4, 5, 6], w: 1 });
    // the matrix has nothing else: no rotation, no shear
    expect(out[1]).toBe(0);
    expect(out[4]).toBe(0);
    expect(out[11]).toBe(0);
  });

  it('collapses a node the timelapse hides or the layout has not placed to nothing', () => {
    const out = new Float32Array(16 * 3).fill(9);
    const visible = Uint8Array.from([1, 0, 1]); // node 1 hidden
    writeInstanceMatrices(out, nodes, pos, visible, null, size);
    expect(read(out, 2).s).toEqual([0, 0, 0]);
    expect(read(out, 0).s).toEqual([12, 12, 12]);
    // positions of two nodes only: node 2 is not placed
    writeInstanceMatrices(out, nodes, pos.subarray(0, 6), null, null, size);
    expect(read(out, 0)).toEqual({ s: [0, 0, 0], at: [0, 0, 0], w: 1 });
    expect(read(out, 1).s).toEqual([10, 10, 10]);
  });

  it('draws smaller the nodes outside the lit neighbourhood', () => {
    const out = new Float32Array(16 * 3);
    const lit = Uint8Array.from([1, 0, 1]);
    writeInstanceMatrices(out, nodes, pos, null, lit, size);
    expect(read(out, 0).s[0]).toBe(12); // lit
    expect(read(out, 2).s[0]).toBeCloseTo(11 * DIM_SCALE, 5); // node 1 stands back
    expect(read(out, 1).s[0]).toBe(10); // lit
  });
});
