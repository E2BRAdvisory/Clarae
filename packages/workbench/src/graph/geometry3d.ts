// Geometry of the 3D graph that needs no WebGL: the vertices of the links (all of them in one
// buffer, drawn as a single LineSegments) and the framing of the camera. Pure functions, so they
// are tested without a scene. Positions are x0,y0,z0,x1,…
/** Segments of the arc drawn for a link whose opposite also exists. */
export const ARC_SEGMENTS = 6;
/** How far an arc bulges, as a fraction of the length of the link. */
const ARC_BULGE = 0.18;

/** Marks the links whose opposite also exists (A→B and B→A): they are drawn as two arcs. */
export function reciprocalEdges(edges: Int32Array, n: number): Uint8Array {
  const m = edges.length >> 1;
  const seen = new Set<number>();
  for (let e = 0; e < m; e++) seen.add((edges[2 * e] as number) * n + (edges[2 * e + 1] as number));
  const out = new Uint8Array(m);
  for (let e = 0; e < m; e++) {
    const s = edges[2 * e] as number;
    const t = edges[2 * e + 1] as number;
    if (s !== t && seen.has(t * n + s)) out[e] = 1;
  }
  return out;
}

/** Where each link sits in the vertex buffer of the links. */
export interface LinkPlan {
  /** source,target pairs. */
  edges: Int32Array;
  /** 1 for a link drawn as an arc. */
  curved: Uint8Array;
  /** First vertex of each link. */
  first: Int32Array;
  /** Vertices in all: two for a straight link, two for each segment of an arc. */
  vertices: number;
}

/** Lays the links out in one buffer; with `curve` the reciprocal ones take an arc each. */
export function planLinks(edges: Int32Array, n: number, curve: boolean): LinkPlan {
  const m = edges.length >> 1;
  const curved = curve ? reciprocalEdges(edges, n) : new Uint8Array(m);
  const first = new Int32Array(m);
  let vertices = 0;
  for (let e = 0; e < m; e++) {
    first[e] = vertices;
    vertices += curved[e] ? 2 * ARC_SEGMENTS : 2;
  }
  return { edges, curved, first, vertices };
}

/**
 * Writes the vertices of the links for the current positions. A link with a hidden end (the
 * timelapse) or an end not placed yet collapses to a point, which draws nothing. An arc bends
 * to the side given by the direction of its link, so the two of a pair open like a lens.
 */
export function writeLinks(
  out: Float32Array,
  plan: LinkPlan,
  pos: Float32Array,
  visible: Uint8Array | null,
): void {
  const { edges, curved, first } = plan;
  const m = edges.length >> 1;
  for (let e = 0; e < m; e++) {
    const s = edges[2 * e] as number;
    const t = edges[2 * e + 1] as number;
    const o = 3 * (first[e] as number);
    const count = curved[e] ? 2 * ARC_SEGMENTS : 2;
    const placed = 3 * s + 2 < pos.length && 3 * t + 2 < pos.length;
    if (!placed || (visible && !(visible[s] && visible[t]))) {
      out.fill(0, o, o + 3 * count);
      continue;
    }
    const ax = pos[3 * s] as number;
    const ay = pos[3 * s + 1] as number;
    const az = pos[3 * s + 2] as number;
    const bx = pos[3 * t] as number;
    const by = pos[3 * t + 1] as number;
    const bz = pos[3 * t + 2] as number;
    if (!curved[e]) {
      out[o] = ax;
      out[o + 1] = ay;
      out[o + 2] = az;
      out[o + 3] = bx;
      out[o + 4] = by;
      out[o + 5] = bz;
      continue;
    }
    // Control point: the middle of the link, pushed sideways (d × axis; the axis is y unless the
    // link runs along it).
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    let px: number;
    let py: number;
    let pz: number;
    if (Math.abs(dy) > 0.9 * len) {
      px = 0; // d × (1,0,0)
      py = dz;
      pz = -dy;
    } else {
      px = -dz; // d × (0,1,0)
      py = 0;
      pz = dx;
    }
    const k = (ARC_BULGE * len) / (Math.hypot(px, py, pz) || 1);
    const cx = (ax + bx) / 2 + px * k;
    const cy = (ay + by) / 2 + py * k;
    const cz = (az + bz) / 2 + pz * k;
    let lx = ax;
    let ly = ay;
    let lz = az;
    for (let j = 1; j <= ARC_SEGMENTS; j++) {
      const u = j / ARC_SEGMENTS;
      const a = (1 - u) * (1 - u);
      const b = 2 * (1 - u) * u;
      const c = u * u;
      const x = a * ax + b * cx + c * bx;
      const y = a * ay + b * cy + c * by;
      const z = a * az + b * cz + c * bz;
      const v = o + 6 * (j - 1);
      out[v] = lx;
      out[v + 1] = ly;
      out[v + 2] = lz;
      out[v + 3] = x;
      out[v + 4] = y;
      out[v + 5] = z;
      lx = x;
      ly = y;
      lz = z;
    }
  }
}

export interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** The sphere around the shown nodes (centre of their box, farthest node); null with none placed. */
export function boundsOf(pos: Float32Array, n: number, visible: Uint8Array | null): Sphere | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const count = Math.min(n, Math.floor(pos.length / 3));
  const shown = (i: number): boolean => (!visible || !!visible[i]) && Number.isFinite(pos[3 * i]);
  for (let i = 0; i < count; i++) {
    if (!shown(i)) continue;
    const x = pos[3 * i] as number;
    const y = pos[3 * i + 1] as number;
    const z = pos[3 * i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (minX === Infinity) return null;
  const x = (minX + maxX) / 2;
  const y = (minY + maxY) / 2;
  const z = (minZ + maxZ) / 2;
  let r = 0;
  for (let i = 0; i < count; i++) {
    if (!shown(i)) continue;
    r = Math.max(
      r,
      Math.hypot(
        (pos[3 * i] as number) - x,
        (pos[3 * i + 1] as number) - y,
        (pos[3 * i + 2] as number) - z,
      ),
    );
  }
  return { x, y, z, r };
}

/** Smallest radius framed: a single node, or a few close ones, are not looked at from too near. */
const MIN_FIT_RADIUS = 40;

/**
 * How far the camera stands from the centre of a sphere to show all of it: the narrower of the
 * two angles of view decides, with a margin around.
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.2): number {
  const v = (fovDeg * Math.PI) / 360;
  const h = Math.atan(Math.tan(v) * Math.max(aspect, 0.01));
  return (Math.max(radius, MIN_FIT_RADIUS) / Math.sin(Math.min(v, h))) * margin;
}
