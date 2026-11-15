// The levels of detail of the 3D graph, and the shape each kind of document has at the middle one.
// Pure: the scene (three/scene.ts, a lazy chunk) and the legend of the graph view (which is not)
// both ask it, so it imports nothing of three.js. The numbers come from the measures in
// docs/qa/graph-3d-benchmark.md.
import type { NodeKind } from './kinds';

/**
 * Three ways to draw the nodes, by how many there are:
 *  - `sprite`: a sprite each (an icon on a disc), a draw call each, draggable, picked by the library;
 *  - `instanced`: an InstancedMesh per shape (a simple solid per kind of document), a draw call each
 *    shape, coloured and sized per instance, picked and dragged by the scene itself;
 *  - `points`: a Points per look (colour and icon), a draw call each look, picked by the scene, not draggable.
 */
export type Lod = 'sprite' | 'instanced' | 'points';

/**
 * Up to this many nodes each one is a sprite: the draw calls (one each) cost about a millisecond of
 * CPU per frame here (0.9 ms at 1.000 nodes, Metal), which is where the instanced solids start to pay.
 */
export const SPRITE_NODES = 1000;
/**
 * Up to this many (and above SPRITE_NODES) the nodes are instanced solids; beyond, points. Solids
 * beat sprites up to here (8 draw calls and 0.1 ms instead of 1.001 to 2.001 calls and 0.9 to 1.8 ms),
 * but beyond they have nothing over points, which draw as fast and with no triangles at all: in a
 * software rasteriser the solids fall behind (7.7 against 24.7 fps in orbit at 5.000 nodes).
 */
export const INSTANCED_NODES = 2000;

declare global {
  interface Window {
    /** E2E builds only: draw the nodes at this level whatever their number (to measure and test each). */
    __CLARAE_GRAPH3D_LOD__?: Lod;
  }
}

/** The level the nodes of a graph are drawn at, by how many there are. */
export function lodFor(nodes: number): Lod {
  const forced = import.meta.env.CLARAE_E2E ? window.__CLARAE_GRAPH3D_LOD__ : undefined;
  if (forced) return forced;
  return nodes <= SPRITE_NODES ? 'sprite' : nodes <= INSTANCED_NODES ? 'instanced' : 'points';
}

/** The solids of the instanced level. */
export type Shape =
  'sphere' | 'cube' | 'octahedron' | 'cylinder' | 'cone' | 'torus' | 'icosahedron';

/** Order of the draws (and of the legend): the commonest first. */
export const SHAPES: readonly Shape[] = [
  'sphere',
  'cube',
  'octahedron',
  'cylinder',
  'cone',
  'torus',
  'icosahedron',
];

/**
 * The solid of a kind of document: a sphere for the notes (and the presentations, which are notes),
 * a cube for the drawings, an octahedron for the canvases, a cylinder for the bases, a cone for
 * every attachment, a torus for the tags and an icosahedron for the notes that do not exist yet.
 */
export function kindShape(kind: NodeKind): Shape {
  switch (kind) {
    case 'note':
    case 'presentation':
      return 'sphere';
    case 'drawing':
      return 'cube';
    case 'canvas':
      return 'octahedron';
    case 'base':
      return 'cylinder';
    case 'tag':
      return 'torus';
    case 'ghost':
      return 'icosahedron';
    default:
      return 'cone';
  }
}

/** The nodes drawn as one InstancedMesh. */
export interface ShapeGroup {
  shape: Shape;
  /** Node indexes, oldest first: the timelapse shows a prefix of them. */
  nodes: Int32Array;
}

/**
 * Splits the nodes by the shape they are drawn with, each group in creation order (`rank`), in the
 * order of SHAPES; a shape no node has gets no group, so no draw call.
 */
export function groupByShape(shapes: readonly Shape[], rank: ArrayLike<number>): ShapeGroup[] {
  const lists = new Map<Shape, number[]>();
  shapes.forEach((shape, i) => {
    const list = lists.get(shape);
    if (list) list.push(i);
    else lists.set(shape, [i]);
  });
  const out: ShapeGroup[] = [];
  for (const shape of SHAPES) {
    const list = lists.get(shape);
    if (!list) continue;
    list.sort((a, b) => (rank[a] as number) - (rank[b] as number));
    out.push({ shape, nodes: Int32Array.from(list) });
  }
  return out;
}

/** How many nodes of a group the timelapse shows: up to the last one of them that is visible. */
export function shownPrefix(nodes: Int32Array, visible: Uint8Array | null): number {
  if (!visible) return nodes.length;
  let shown = 0;
  for (let k = 0; k < nodes.length; k++) if (visible[nodes[k] as number]) shown = k + 1;
  return shown;
}

/** Fraction of its size a node that stands back (not in the lit neighbourhood) is drawn at. */
export const DIM_SCALE = 0.7;
/** How far the colour of a node that stands back is taken to that of the background (0..1). */
export const DIM_MIX = 0.8;

/**
 * Writes the instance matrices of a group (column-major 4×4, a uniform scale and a translation).
 * A node that is not placed yet, or that the timelapse hides, is scaled to nothing: it draws no
 * pixel whatever `count` says. `scale(i)` is the full size of node `i`; `lit` (null: all) marks the nodes that do not stand back.
 */
export function writeInstanceMatrices(
  out: Float32Array,
  nodes: Int32Array,
  pos: Float32Array,
  visible: Uint8Array | null,
  lit: Uint8Array | null,
  scale: (i: number) => number,
): void {
  for (let k = 0; k < nodes.length; k++) {
    const i = nodes[k] as number;
    const o = 16 * k;
    const placed = 3 * i + 2 < pos.length && (!visible || !!visible[i]);
    const s = placed ? scale(i) * (lit && !lit[i] ? DIM_SCALE : 1) : 0;
    out[o] = s;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = 0;
    out[o + 5] = s;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = s;
    out[o + 11] = 0;
    out[o + 12] = placed ? (pos[3 * i] as number) : 0;
    out[o + 13] = placed ? (pos[3 * i + 1] as number) : 0;
    out[o + 14] = placed ? (pos[3 * i + 2] as number) : 0;
    out[o + 15] = 1;
  }
}
