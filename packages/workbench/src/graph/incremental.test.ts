import { describe, expect, it } from 'vitest';
import type { VaultChangeBatch } from '../app/fileChanges';
import { graphNeedsReload, sameGraph, seedPositions } from './incremental';
import { LayoutEngine, edgePairs, WARM_ALPHA } from './layoutEngine';
import { buildModel } from './model';
import { defaultForces, type GraphData } from './types';

const batch = (changes: VaultChangeBatch['changes'], unknown = false): VaultChangeBatch => ({
  vaultId: 'v',
  changes,
  unknown,
  paths: changes.map((c) => c.path),
});

const note = (id: string, created = 1) => ({
  id,
  label: id.replace(/\.md$/, ''),
  kind: 'note',
  path: id,
  degree: 0,
  created,
});

const graph = (ids: string[], edges: [number, number][], created = 1): GraphData => ({
  nodes: ids.map((id) => note(id, created)),
  edges: edges.map(([source, target]) => ({ source, target })),
  truncated: false,
  total: ids.length,
});

describe('graph refresh', () => {
  it('reloads only for changes that can alter nodes or links', () => {
    // The app's own writes of its settings and workspace.
    expect(graphNeedsReload(batch([{ type: 'modify', path: '.clarae/workspace.json' }]))).toBe(
      false,
    );
    expect(graphNeedsReload(batch([{ type: 'create', path: '.clarae/graph.json' }]))).toBe(false);
    // An edited attachment or canvas has no links in the graph.
    expect(graphNeedsReload(batch([{ type: 'modify', path: 'img/a.png' }]))).toBe(false);
    expect(graphNeedsReload(batch([{ type: 'modify', path: 'board.canvas' }]))).toBe(false);
    // An edited note may have new links, tags or properties; files come and go.
    expect(graphNeedsReload(batch([{ type: 'modify', path: 'A.md' }]))).toBe(true);
    expect(graphNeedsReload(batch([{ type: 'create', path: 'img/b.png' }]))).toBe(true);
    expect(graphNeedsReload(batch([{ type: 'delete', path: 'B.md' }]))).toBe(true);
    // An older core without typed changes: anything may have changed.
    expect(graphNeedsReload(batch([], true))).toBe(true);
  });

  it('tells an unchanged graph from a changed one, whatever the modification times', () => {
    const a = graph(['A.md', 'B.md'], [[0, 1]], 100);
    expect(sameGraph(a, graph(['A.md', 'B.md'], [[0, 1]], 200))).toBe(true);
    expect(sameGraph(a, graph(['A.md', 'B.md'], []))).toBe(false);
    expect(sameGraph(a, graph(['A.md', 'C.md'], [[0, 1]]))).toBe(false);
    const grouped = graph(['A.md', 'B.md'], [[0, 1]]);
    (grouped.nodes[0] as { groups?: number[] }).groups = [0];
    expect(sameGraph(a, grouped)).toBe(false);
    expect(sameGraph(a, { ...a, truncated: true })).toBe(false);
  });

  it('keeps the place of the nodes already shown and puts new ones next to their neighbours', () => {
    const prev = {
      ids: ['A.md', 'B.md', 'Gone.md'],
      positions: Float32Array.of(0, 0, 100, 0, 9, 9),
    };
    // B is now linked to a new note N; Lonely has no placed neighbour.
    const m = buildModel(
      graph(
        ['A.md', 'B.md', 'Lonely.md', 'N.md'],
        [
          [0, 1],
          [1, 3],
        ],
      ),
    );
    const seed = seedPositions(prev, m);
    expect(seed).not.toBeNull();
    const s = seed as Float32Array;
    expect([s[0], s[1], s[2], s[3]]).toEqual([0, 0, 100, 0]);
    expect(Number.isNaN(s[4] as number)).toBe(true);
    expect(Math.hypot((s[6] as number) - 100, s[7] as number)).toBeLessThan(20);
    expect(seedPositions({ ids: ['X.md'], positions: Float32Array.of(1, 1) }, m)).toBeNull();
  });

  it('starts a warm layout from the given positions and barely moves a settled graph', () => {
    const data = graph(
      ['A.md', 'B.md', 'C.md', 'D.md'],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    const cold = new LayoutEngine(4, edgePairs(data.edges), defaultForces);
    while (!cold.settled) cold.tick(1);
    const settled = cold.snapshot();

    const warm = new LayoutEngine(4, edgePairs(data.edges), defaultForces, {
      positions: settled,
      alpha: WARM_ALPHA,
    });
    expect(Array.from(warm.snapshot())).toEqual(Array.from(settled));
    while (!warm.settled) warm.tick(1);
    expect(warm.tickCount).toBeLessThan(cold.tickCount);
    const after = warm.snapshot();
    for (let i = 0; i < 4; i++) {
      const moved = Math.hypot(
        (after[2 * i] as number) - (settled[2 * i] as number),
        (after[2 * i + 1] as number) - (settled[2 * i + 1] as number),
      );
      expect(moved).toBeLessThan(5);
    }
  });
});
