import { describe, expect, it } from 'vitest';
import { buildMockGraph, type MockSource } from './mockBuild';
import { buildModel, CLASS_GHOST, CLASS_GROUP, timelapseTime, visibleAt } from './model';
import { graphCenter, graphTitle, isGraphPath, localGraphPath } from './paths';
import { LayoutEngine, edgePairs } from './layoutEngine';
import { mergeGraphSettings, parseGraphSettings } from './settings';
import { syntheticGraph } from './synthetic';
import { defaultForces } from './types';
import { fitView, hitTest, panBy, toWorld, zoomAt } from './view';

describe('graph paths', () => {
  it('tells graph tabs from files and extracts the centre', () => {
    expect(isGraphPath('graph://global')).toBe(true);
    expect(isGraphPath('notes/a.md')).toBe(false);
    const p = localGraphPath('dir/A note.md');
    expect(isGraphPath(p)).toBe(true);
    expect(graphCenter(p)).toBe('dir/A note.md');
    expect(graphCenter('graph://global')).toBeNull();
    expect(graphTitle(p)).toEqual({ key: 'graph.localTitle', name: 'A note' });
  });
});

describe('graph settings', () => {
  it('falls back to defaults and clamps hand-edited values', () => {
    expect(parseGraphSettings('').showOrphans).toBe(true);
    expect(parseGraphSettings('{oops').localDepth).toBe(1);
    const s = mergeGraphSettings({
      forces: { repel: 999, center: 'x' },
      nodeSize: -4,
      localDirection: 'sideways',
      groups: [{ query: 'tag:a', color: 'red' }, 5, { query: 'b', color: '#00ff00' }],
      tags: ['a', 3, ''],
    });
    expect(s.forces.repel).toBe(20);
    expect(s.forces.center).toBe(defaultForces.center);
    expect(s.nodeSize).toBe(0.5);
    expect(s.localDirection).toBe('both');
    expect(s.groups).toHaveLength(2);
    expect(s.groups[0]?.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(s.groups[1]?.color).toBe('#00ff00');
    expect(s.tags).toEqual(['a']);
  });
});

describe('graph model', () => {
  const data = {
    nodes: [
      { id: 'a.md', label: 'a', kind: 'note', path: 'a.md', degree: 2, created: 300, groups: [1] },
      { id: 'b.md', label: 'b', kind: 'note', path: 'b.md', degree: 1, created: 100 },
      { id: 'ghost:x', label: 'x', kind: 'ghost', path: '', degree: 1, created: 0 },
    ],
    edges: [
      { source: 0, target: 1 },
      { source: 0, target: 2 },
    ],
    truncated: false,
    total: 3,
  };
  it('builds flat arrays, adjacency and classes', () => {
    const m = buildModel(data);
    expect(Array.from(m.degree)).toEqual([2, 1, 1]);
    expect(Array.from(m.adj.slice(m.off[0], m.off[1]))).toEqual([1, 2]);
    expect(m.cls[0]).toBe(CLASS_GROUP + 1);
    expect(m.cls[2]).toBe(CLASS_GHOST);
    expect((m.radius[0] as number) > (m.radius[1] as number)).toBe(true);
  });
  it('orders by creation time, ghosts follow their oldest neighbour', () => {
    const m = buildModel(data);
    // b (100), ghost (time of a = 300), a (300): a before ghost by index tie-break
    expect(m.rank[1]).toBe(0);
    expect(m.rank[0]).toBeLessThan(m.rank[2] as number);
  });
  it('reveals nodes progressively for the timelapse', () => {
    const m = buildModel(data);
    expect(visibleAt(m, 1)).toBeNull();
    expect(Array.from(visibleAt(m, 0.34) as Uint8Array)).toEqual([0, 1, 0]);
    expect(timelapseTime(m, 0.34)).toBe(100);
  });
});

describe('view maths', () => {
  it('zooms around the cursor and round-trips coordinates', () => {
    const v = zoomAt({ k: 1, x: 0, y: 0 }, 100, 50, 2);
    expect(v.k).toBe(2);
    const w = toWorld(v, 100, 50);
    expect(w.x).toBeCloseTo(100);
    expect(w.y).toBeCloseTo(50);
    expect(panBy(v, 5, -5)).toEqual({ k: 2, x: v.x + 5, y: v.y - 5 });
  });
  it('fits and hit-tests', () => {
    const pos = Float32Array.from([-100, 0, 100, 0]);
    const v = fitView(pos, 2, 400, 200);
    expect(v.x).toBeCloseTo(200);
    const r = Float32Array.from([5, 5]);
    expect(hitTest(v, pos, r, 2, null, 200 + 100 * v.k, 100)).toBe(1);
    expect(hitTest(v, pos, r, 2, Uint8Array.from([1, 0]), 200 + 100 * v.k, 100)).toBe(-1);
    expect(hitTest(v, pos, r, 2, null, 200, 10)).toBe(-1);
  });
});

describe('layout engine', () => {
  it('separates connected components and keeps linked nodes close', () => {
    const g = syntheticGraph(200, 2);
    const e = new LayoutEngine(g.nodes.length, edgePairs(g.edges), defaultForces);
    e.tick(150);
    const p = e.snapshot();
    expect(p.every(Number.isFinite)).toBe(true);
    const dist = (a: number, b: number): number =>
      Math.hypot(
        (p[2 * a] as number) - (p[2 * b] as number),
        (p[2 * a + 1] as number) - (p[2 * b + 1] as number),
      );
    const linked = g.edges.reduce((s, x) => s + dist(x.source, x.target), 0) / g.edges.length;
    let rnd = 0;
    for (let i = 0; i < 200; i++) rnd += dist(i, (i * 37 + 11) % 200);
    expect(linked).toBeLessThan(rnd / 200);
  });
  it('reheats when forces change', () => {
    const e = new LayoutEngine(20, edgePairs(syntheticGraph(20).edges), defaultForces);
    e.tick(400);
    expect(e.settled).toBe(true);
    e.setForces({ ...defaultForces, repel: 20 });
    expect(e.settled).toBe(false);
  });
});

describe('mock graph builder', () => {
  const files: Record<string, string> = {
    'a.md': '[[b]] [[nope]] #t',
    'b.md': '[[c]]',
    'c.md': 'x',
    'lone.md': 'y',
  };
  const src: MockSource = {
    paths: Object.keys(files),
    links: (p) =>
      ({
        'a.md': [
          { path: 'b.md', raw: 'b' },
          { path: '', raw: 'nope' },
        ],
        'b.md': [{ path: 'c.md', raw: 'c' }],
      })[p] ?? [],
    tags: (p) => (p === 'a.md' ? ['t'] : []),
    text: (p) => files[p] ?? '',
  };
  it('honours toggles, filters and local depth', () => {
    const base = { showOrphans: false, showGhosts: false, showTags: false };
    expect(buildMockGraph(src, base).nodes.map((n) => n.id)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(buildMockGraph(src, { ...base, showOrphans: true }).nodes).toHaveLength(4);
    expect(buildMockGraph(src, { ...base, showGhosts: true, showTags: true }).nodes).toHaveLength(
      5,
    );
    expect(buildMockGraph(src, { ...base, tags: ['t'], showOrphans: true }).nodes).toHaveLength(1);
    const local = buildMockGraph(src, { ...base, center: 'a.md', depth: 1, direction: 'out' });
    expect(local.nodes.map((n) => n.id)).toEqual(['a.md', 'b.md']);
    const grouped = buildMockGraph(src, { ...base, groups: ['tag:t'] });
    expect(grouped.nodes[0]?.groups).toEqual([0]);
  });
});
