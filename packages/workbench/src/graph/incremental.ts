// Keeping an open graph steady while the vault changes. The graph used to be rebuilt, laid out
// from scratch and refitted after every vault:file-changed, the app's own autosaves included, so it
// "exploded" at every pause in typing. Now only changes that can alter nodes or links ask for a new
// build, an answer with the same nodes and links is dropped, and a changed graph starts its layout
// from the previous positions (the new nodes next to their neighbours) without moving the view.
import type { VaultChangeBatch } from '../app/fileChanges';
import type { GraphModel } from './model';
import type { GraphData } from './types';

/** Device and vault settings (.clarae/): never part of the graph. */
const isConfig = (path: string): boolean => path === '.clarae' || path.startsWith('.clarae/');
const isNote = (path: string): boolean => /\.md$/i.test(path);

/**
 * Whether a batch of file changes can alter the graph. Creations, deletions and renames add or
 * remove nodes; an edited note may have gained or lost links, tags or the properties the filters
 * and groups match. An edited attachment or canvas, and any change under .clarae/, cannot.
 */
export function graphNeedsReload(batch: VaultChangeBatch): boolean {
  if (batch.unknown) return true;
  return batch.changes.some((c) => !isConfig(c.path) && (c.type !== 'modify' || isNote(c.path)));
}

const sameGroups = (
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean => {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((g, i) => g === y[i]);
};

/**
 * True when two answers draw the same graph: same nodes (identity, label, kind, colour groups) in
 * the same order and the same links. The creation time is left out: for a note without a `created`
 * property it is its modification time, which every save changes (it only orders the timelapse).
 */
export function sameGraph(a: GraphData, b: GraphData): boolean {
  if (a.truncated !== b.truncated || a.total !== b.total) return false;
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.label !== y.label || x.kind !== y.kind || x.path !== y.path)
      return false;
    if (!sameGroups(x.groups, y.groups)) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    const x = a.edges[i];
    const y = b.edges[i];
    if (!x || !y || x.source !== y.source || x.target !== y.target) return false;
  }
  return true;
}

/** Where the previous layout left its nodes. */
export interface PreviousLayout {
  ids: readonly string[];
  /** x0,y0,x1,y1,… in the order of ids. */
  positions: Float32Array;
}

/** Spread of the new nodes around their neighbours, in world units. */
const NEW_NODE_OFFSET = 12;

/**
 * Starting positions for a new model from the previous layout: a node that was already shown keeps
 * its place, a new one starts next to its placed neighbours (NaN: no neighbour, the layout engine
 * places it). Null when no node is left in common (lay out from scratch).
 */
export function seedPositions(prev: PreviousLayout, m: GraphModel): Float32Array | null {
  const was = new Map<string, number>();
  prev.ids.forEach((id, i) => {
    if (2 * i + 1 < prev.positions.length) was.set(id, i);
  });
  const out = new Float32Array(m.n * 2).fill(NaN);
  let kept = 0;
  for (let i = 0; i < m.n; i++) {
    const j = was.get((m.data.nodes[i] as { id: string }).id);
    if (j === undefined) continue;
    const x = prev.positions[2 * j] as number;
    const y = prev.positions[2 * j + 1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[2 * i] = x;
    out[2 * i + 1] = y;
    kept++;
  }
  if (kept === 0) return null;
  // New nodes: next to the mean of their placed neighbours, each at its own angle.
  for (let i = 0; i < m.n; i++) {
    if (!Number.isNaN(out[2 * i])) continue;
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let k = m.off[i] as number; k < (m.off[i + 1] as number); k++) {
      const nb = m.adj[k] as number;
      const x = out[2 * nb] as number;
      if (Number.isNaN(x) || nb === i) continue;
      sx += x;
      sy += out[2 * nb + 1] as number;
      c++;
    }
    if (c === 0) continue;
    const angle = i * 2.399963; // golden angle: neighbours of one node fan out
    out[2 * i] = sx / c + Math.cos(angle) * NEW_NODE_OFFSET;
    out[2 * i + 1] = sy / c + Math.sin(angle) * NEW_NODE_OFFSET;
  }
  return out;
}
