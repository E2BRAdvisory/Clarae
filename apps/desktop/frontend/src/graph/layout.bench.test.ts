// Headless benchmark of the layout step (d3-force on the main thread, Node/V8). It only runs
// when MEMOBRAIN_GRAPH_BENCH is set, so CI is not slowed down:
//
//   MEMOBRAIN_GRAPH_BENCH=10000 yarn workspace @memobrain/desktop-frontend exec vitest run src/graph/layout.bench.test.ts
//
// The render loop is measured in a real browser by e2e/graph-bench.spec.ts. Results are
// recorded in docs/qa/m6-graph-benchmark.md.
import { describe, expect, it } from 'vitest';
import { edgePairs, LayoutEngine } from './layoutEngine';
import { buildModel } from './model';
import { syntheticGraph } from './synthetic';
import { defaultForces } from './types';

const proc = (
  globalThis as unknown as {
    process: { env: Record<string, string | undefined>; stdout: { write(s: string): void } };
  }
).process;
const n = Number(proc.env['MEMOBRAIN_GRAPH_BENCH'] ?? 0);

describe.skipIf(!n)('layout benchmark', () => {
  it(`ticks a ${n}-node graph`, () => {
    const g = syntheticGraph(n);
    let t = performance.now();
    const m = buildModel(g);
    const modelMs = performance.now() - t;
    t = performance.now();
    const e = new LayoutEngine(n, edgePairs(g.edges), defaultForces);
    const initMs = performance.now() - t;
    const samples: number[] = [];
    while (!e.settled && samples.length < 1000) {
      t = performance.now();
      e.tick(1);
      samples.push(performance.now() - t);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const total = samples.reduce((a, b) => a + b, 0);
    const pct = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))] as number;
    proc.stdout.write(
      JSON.stringify({
        nodes: n,
        edges: g.edges.length,
        modelMs: +modelMs.toFixed(1),
        initMs: +initMs.toFixed(1),
        ticks: samples.length,
        settleMs: +total.toFixed(0),
        tickMedianMs: +pct(0.5).toFixed(2),
        tickP95Ms: +pct(0.95).toFixed(2),
      }) + '\n',
    );
    expect(m.n).toBe(n);
    expect(samples.length).toBeGreaterThan(10);
  }, 600_000);
});
