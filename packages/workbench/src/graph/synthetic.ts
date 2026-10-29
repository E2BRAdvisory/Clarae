// Synthetic graphs for tests, the in-memory Wails mock and the benchmark harness.
import type { GraphData, GraphNode } from './types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A knowledge-base-like graph: each note links to about `links` earlier ones, chosen
 * preferentially (popular notes attract more links), so degrees follow a heavy tail and
 * creation times increase with the index.
 */
export function syntheticGraph(n: number, links = 3, seed = 1): GraphData {
  const rnd = mulberry32(seed);
  const start = Date.UTC(2022, 0, 1);
  const nodes: GraphNode[] = [];
  const edges: { source: number; target: number }[] = [];
  const pool: number[] = []; // each node appears once per incident edge, plus once
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `n${i}.md`,
      label: `Note ${i}`,
      kind: 'note',
      path: `n${i}.md`,
      degree: 0,
      created: start + i * 3_600_000,
    });
    if (i > 0) {
      const seen = new Set<number>();
      const want = 1 + Math.floor(rnd() * links * 2 - 0.0001);
      for (let k = 0; k < want; k++) {
        const t = pool[Math.floor(rnd() * pool.length)] ?? 0;
        if (t === i || seen.has(t)) continue;
        seen.add(t);
        edges.push({ source: i, target: t });
        pool.push(t, i);
      }
    }
    pool.push(i);
  }
  for (const e of edges) {
    (nodes[e.source] as GraphNode).degree++;
    (nodes[e.target] as GraphNode).degree++;
  }
  return { nodes, edges, truncated: false, total: n };
}
