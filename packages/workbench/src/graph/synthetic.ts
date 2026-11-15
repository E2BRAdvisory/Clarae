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
 * The kinds of document of a mixed graph, with their share in a thousand: what a vault of notes
 * with some drawings, canvases, bases, attachments and tags looks like. The last two are not files.
 */
const MIX: readonly { kind: string; path: (i: number) => string; per: number }[] = [
  { kind: 'note', path: (i) => `n${i}.md`, per: 600 },
  { kind: 'drawing', path: (i) => `d${i}.excalidraw`, per: 70 },
  { kind: 'canvas', path: (i) => `c${i}.canvas`, per: 50 },
  { kind: 'base', path: (i) => `b${i}.base`, per: 40 },
  { kind: 'attachment', path: (i) => `a${i}.png`, per: 100 },
  { kind: 'attachment', path: (i) => `a${i}.pdf`, per: 50 },
  { kind: 'attachment', path: (i) => `a${i}.mp3`, per: 30 },
  { kind: 'tag', path: () => '', per: 40 },
  { kind: 'ghost', path: () => '', per: 20 },
];

/** The kind and the path of node `i` of a mixed graph: a fixed share of each kind, in a fixed order of draw. */
function mixed(i: number): { kind: string; path: string } {
  // A hash of the index, apart from the generator of the links: the links do not change with it.
  const h = Math.imul(i + 1, 0x9e3779b1) >>> 0;
  let r = (h >>> 8) % 1000;
  for (const m of MIX) {
    if (r < m.per) return { kind: m.kind, path: m.path(i) };
    r -= m.per;
  }
  return { kind: 'note', path: `n${i}.md` };
}

/**
 * A knowledge-base-like graph: each note links to about `links` earlier ones, chosen
 * preferentially (popular notes attract more links), so degrees follow a heavy tail and
 * creation times increase with the index. All nodes are notes unless `kinds` asks for a mix of
 * the kinds of document (the links are the same either way).
 */
export function syntheticGraph(n: number, links = 3, seed = 1, kinds = false): GraphData {
  const rnd = mulberry32(seed);
  const start = Date.UTC(2022, 0, 1);
  const nodes: GraphNode[] = [];
  const edges: { source: number; target: number }[] = [];
  const pool: number[] = []; // each node appears once per incident edge, plus once
  for (let i = 0; i < n; i++) {
    const k = kinds ? mixed(i) : { kind: 'note', path: `n${i}.md` };
    nodes.push({
      id: k.path || `n${i}.md`,
      label: `Note ${i}`,
      kind: k.kind,
      path: k.path,
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
