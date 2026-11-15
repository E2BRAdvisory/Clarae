// Keeping an open graph steady while the vault changes. The graph used to be rebuilt, laid out
// from scratch and refitted after every vault:file-changed, the app's own autosaves included, so it
// "exploded" at every pause in typing. Now only changes that can alter nodes or links ask for a new
// build, an answer with the same nodes and links is dropped, and a changed graph starts its layout
// from the previous positions (the new nodes next to their neighbours) without moving the view.
import type { VaultChangeBatch } from '../app/fileChanges';
import type { GraphModel } from './model';
import type { GraphData } from './types';
import { isConfigPath } from '../platform/vaultPaths';

/** Device and vault settings (the configuration folder): never part of the graph. */
const isConfig = isConfigPath;
/** Files whose content holds links: a note, a presentation, a drawing, a canvas. */
const hasLinks = (path: string): boolean => /\.(md|marp|excalidraw|canvas)$/i.test(path);

/**
 * Whether a batch of file changes can alter the graph. Creations, deletions and renames add or
 * remove nodes; an edited note may have gained or lost links, tags or the properties the filters
 * and groups match, and an edited drawing or canvas the links it holds. An edited attachment or
 * base, and any change under .clarae/, cannot.
 */
export function graphNeedsReload(batch: VaultChangeBatch): boolean {
  if (batch.unknown) return true;
  return batch.changes.some((c) => !isConfig(c.path) && (c.type !== 'modify' || hasLinks(c.path)));
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
  /** x0,y0,x1,y1,… in the order of ids (x0,y0,z0,… for a layout in three dimensions). */
  positions: Float32Array;
}

/** Spread of the new nodes around their neighbours, in world units. */
const NEW_NODE_OFFSET = 12;

/**
 * Starting positions for a new model from the previous layout: a node that was already shown keeps
 * its place, a new one starts next to its placed neighbours (NaN: no neighbour, the layout engine
 * places it). Null when no node is left in common (lay out from scratch). `dims` is the number of
 * coordinates of a node, in the previous layout and in the answer.
 */
export function seedPositions(
  prev: PreviousLayout,
  m: GraphModel,
  dims: 2 | 3 = 2,
): Float32Array | null {
  const was = new Map<string, number>();
  prev.ids.forEach((id, i) => {
    if (dims * i + dims - 1 < prev.positions.length) was.set(id, i);
  });
  const out = new Float32Array(m.n * dims).fill(NaN);
  let kept = 0;
  for (let i = 0; i < m.n; i++) {
    const j = was.get((m.data.nodes[i] as { id: string }).id);
    if (j === undefined) continue;
    let finite = true;
    for (let d = 0; d < dims; d++) finite &&= Number.isFinite(prev.positions[dims * j + d]);
    if (!finite) continue;
    for (let d = 0; d < dims; d++) out[dims * i + d] = prev.positions[dims * j + d] as number;
    kept++;
  }
  if (kept === 0) return null;
  // New nodes: next to the mean of their placed neighbours, each at its own angle.
  const sum = [0, 0, 0];
  for (let i = 0; i < m.n; i++) {
    if (!Number.isNaN(out[dims * i])) continue;
    sum.fill(0);
    let c = 0;
    for (let k = m.off[i] as number; k < (m.off[i + 1] as number); k++) {
      const nb = m.adj[k] as number;
      if (Number.isNaN(out[dims * nb]) || nb === i) continue;
      for (let d = 0; d < dims; d++) sum[d] = (sum[d] as number) + (out[dims * nb + d] as number);
      c++;
    }
    if (c === 0) continue;
    const angle = i * 2.399963; // golden angle: neighbours of one node fan out
    // In space the same angle walks a sphere: the height goes from pole to pole as i grows.
    const h = dims === 3 ? ((i * 0.618034) % 1) * 2 - 1 : 0;
    const ring = Math.sqrt(1 - h * h) * NEW_NODE_OFFSET;
    out[dims * i] = (sum[0] as number) / c + Math.cos(angle) * ring;
    out[dims * i + 1] = (sum[1] as number) / c + Math.sin(angle) * ring;
    if (dims === 3) out[dims * i + 2] = (sum[2] as number) / c + h * NEW_NODE_OFFSET;
  }
  return out;
}
