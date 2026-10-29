// "Auto Layout": arranges the selected shapes in layers from left to right following the arrows
// that join them (a flow chart or tree), the way a graph layout would. Layers come from the
// longest path from a root; loops are broken at the arrow that closes them. Arrows follow their
// shapes (PatchBuilder drags the bound ends), labels follow their containers.
import { arrangeable, num, PatchBuilder } from './geometry';
import type { SceneAction, SceneElement } from './types';

const boundId = (b: unknown): string | null => {
  const id = (b as { elementId?: unknown } | null)?.elementId;
  return typeof id === 'string' ? id : null;
};

/** Layer index of every node, from the edges (from → to). Back edges are ignored. */
export function layersOf(
  nodes: readonly string[],
  edges: readonly [string, string][],
): Map<string, number> {
  const out = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) if (a !== b) out.get(a)?.push(b);
  // Depth-first walk (in the given node order) to find the edges that close a loop.
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const visit = (n: string): void => {
    state.set(n, 1);
    for (const m of out.get(n) ?? []) {
      if (state.get(m) === 1) back.add(`${n}>${m}`);
      else if (!state.get(m)) visit(m);
    }
    state.set(n, 2);
  };
  for (const n of nodes) if (!state.get(n)) visit(n);
  const layer = new Map<string, number>(nodes.map((n) => [n, 0]));
  // Longest path over the remaining DAG, relaxed until stable (at most |nodes| rounds).
  for (let round = 0; round < nodes.length; round++) {
    let changed = false;
    for (const [a, b] of edges) {
      if (a === b || back.has(`${a}>${b}`)) continue;
      const next = (layer.get(a) ?? 0) + 1;
      if (next > (layer.get(b) ?? 0)) {
        layer.set(b, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

export const autoLayout: SceneAction = {
  id: 'auto-layout',
  group: 'layout',
  needs: 2,
  params: [
    { key: 'hgap', default: 100, min: 0 },
    { key: 'vgap', default: 40, min: 0 },
  ],
  run(ctx) {
    const nodes = arrangeable(ctx);
    if (nodes.length < 2) return {};
    const ids = new Set(nodes.map((n) => n.id));
    const edges: [string, string][] = [];
    for (const a of ctx.elements) {
      if (a.type !== 'arrow' || a.isDeleted) continue;
      const from = boundId(a.startBinding);
      const to = boundId(a.endBinding);
      if (from && to && ids.has(from) && ids.has(to)) edges.push([from, to]);
    }
    const order = [...nodes].sort((a, b) => num(a, 'x') - num(b, 'x') || num(a, 'y') - num(b, 'y'));
    const layer = layersOf(
      order.map((n) => n.id),
      edges,
    );
    const columns = new Map<number, SceneElement[]>();
    for (const n of order) {
      const l = layer.get(n.id) ?? 0;
      columns.set(l, [...(columns.get(l) ?? []), n]);
    }
    const hgap = ctx.params?.hgap ?? 100;
    const vgap = ctx.params?.vgap ?? 40;
    const originX = Math.min(...nodes.map((n) => num(n, 'x')));
    const centerY =
      nodes.reduce((s, n) => s + num(n, 'y') + num(n, 'height') / 2, 0) / nodes.length;
    const pb = new PatchBuilder(ctx);
    let x = originX;
    for (const l of [...columns.keys()].sort((a, b) => a - b)) {
      const col = (columns.get(l) as SceneElement[]).sort((a, b) => num(a, 'y') - num(b, 'y'));
      const total = col.reduce((s, n) => s + num(n, 'height'), 0) + vgap * (col.length - 1);
      let y = centerY - total / 2;
      for (const n of col) {
        pb.moveTo(n, x, y);
        y += num(n, 'height') + vgap;
      }
      x += Math.max(...col.map((n) => num(n, 'width'))) + hgap;
    }
    return pb.build();
  },
};
