// Typed-array model of a graph answer: everything the layout and the renderer iterate over
// per frame is a flat array (no per-node objects), which keeps 10k nodes cheap.
import type { GraphData } from './types';

/** Node classes; group colours start at CLASS_GROUP + group index. */
export const CLASS_NOTE = 0;
export const CLASS_GHOST = 1;
export const CLASS_ATTACHMENT = 2;
export const CLASS_TAG = 3;
export const CLASS_GROUP = 4;

export interface GraphModel {
  data: GraphData;
  n: number;
  /** source,target pairs. */
  edges: Int32Array;
  degree: Int32Array;
  /** Node radius in world units. */
  radius: Float32Array;
  /** CLASS_* or CLASS_GROUP + index of the first matching colour group. */
  cls: Uint8Array;
  /** CSR adjacency (both directions): neighbours of i are adj[off[i] .. off[i + 1]). */
  off: Int32Array;
  adj: Int32Array;
  /** Position of each node in the creation order (0 = oldest). */
  rank: Int32Array;
}

export function nodeRadius(degree: number, scale: number): number {
  return (3 + Math.sqrt(degree) * 1.6) * scale;
}

export function buildModel(data: GraphData, nodeSize = 1): GraphModel {
  const n = data.nodes.length;
  const m = data.edges.length;
  const edges = new Int32Array(m * 2);
  const degree = new Int32Array(n);
  for (let i = 0; i < m; i++) {
    const e = data.edges[i] as { source: number; target: number };
    edges[2 * i] = e.source;
    edges[2 * i + 1] = e.target;
    degree[e.source] = (degree[e.source] ?? 0) + 1;
    degree[e.target] = (degree[e.target] ?? 0) + 1;
  }
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = (off[i] ?? 0) + (degree[i] ?? 0);
  const fill = off.slice(0, n);
  const adj = new Int32Array(m * 2);
  for (let i = 0; i < m; i++) {
    const s = edges[2 * i] as number;
    const t = edges[2 * i + 1] as number;
    adj[fill[s] as number] = t;
    fill[s] = (fill[s] as number) + 1;
    adj[fill[t] as number] = s;
    fill[t] = (fill[t] as number) + 1;
  }
  const radius = new Float32Array(n);
  const cls = new Uint8Array(n);
  data.nodes.forEach((nd, i) => {
    radius[i] = nodeRadius(degree[i] ?? 0, nodeSize);
    const g = nd.groups?.[0];
    cls[i] =
      g !== undefined
        ? Math.min(255, CLASS_GROUP + g)
        : nd.kind === 'ghost'
          ? CLASS_GHOST
          : nd.kind === 'attachment'
            ? CLASS_ATTACHMENT
            : nd.kind === 'tag'
              ? CLASS_TAG
              : CLASS_NOTE;
  });
  return { data, n, edges, degree, radius, cls, off, adj, rank: creationRanks(data, off, adj) };
}

/**
 * Creation order for the timelapse. Notes and attachments use their creation time (see
 * graph.Node.Created); ghosts and tags have none, so they appear with the oldest note
 * that links to them.
 */
export function creationRanks(data: GraphData, off: Int32Array, adj: Int32Array): Int32Array {
  const n = data.nodes.length;
  const time = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const nd = data.nodes[i];
    if (nd && nd.path !== '') {
      time[i] = nd.created;
      continue;
    }
    let t = Infinity;
    for (let k = off[i] as number; k < (off[i + 1] as number); k++)
      t = Math.min(t, data.nodes[adj[k] as number]?.created ?? Infinity);
    time[i] = Number.isFinite(t) ? t : 0;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (time[a] as number) - (time[b] as number) || a - b,
  );
  const rank = new Int32Array(n);
  order.forEach((idx, r) => {
    rank[idx] = r;
  });
  return rank;
}

/** Nodes shown at timelapse progress p in 0..1; null shows everything. */
export function visibleAt(model: GraphModel, progress: number): Uint8Array | null {
  if (progress >= 1) return null;
  const limit = Math.floor(progress * model.n);
  const out = new Uint8Array(model.n);
  for (let i = 0; i < model.n; i++) out[i] = (model.rank[i] as number) < limit ? 1 : 0;
  return out;
}

/** The creation date of the most recent node shown at progress p (ms), for the timelapse caption. */
export function timelapseTime(model: GraphModel, progress: number): number | null {
  const limit = Math.min(model.n, Math.max(1, Math.floor(progress * model.n)));
  let best: number | null = null;
  for (let i = 0; i < model.n; i++) {
    if ((model.rank[i] as number) === limit - 1) {
      const nd = model.data.nodes[i];
      if (nd && nd.path !== '') best = nd.created;
    }
  }
  return best;
}
