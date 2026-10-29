// Pan/zoom transform of the graph canvas: screen = world * k + (x, y), in CSS pixels.
export interface View {
  k: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 12;

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function toWorld(v: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
}

/** Zooms by factor keeping the world point under (sx, sy) fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const k = clampZoom(v.k * factor);
  const f = k / v.k;
  return { k, x: sx - (sx - v.x) * f, y: sy - (sy - v.y) * f };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { k: v.k, x: v.x + dx, y: v.y + dy };
}

/** The view that fits the bounding box of the positions in a w x h viewport, with a margin. */
export function fitView(positions: Float32Array, n: number, w: number, h: number): View {
  if (n === 0 || w <= 0 || h <= 0) return { k: 1, x: w / 2, y: h / 2 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[2 * i] as number;
    const y = positions[2 * i + 1] as number;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const margin = 40;
  const k = clampZoom(Math.min((w - 2 * margin) / bw, (h - 2 * margin) / bh, 3));
  return { k, x: w / 2 - ((minX + maxX) / 2) * k, y: h / 2 - ((minY + maxY) / 2) * k };
}

/**
 * The node under a screen point (the topmost, i.e. last drawn, within its radius plus a
 * small tolerance), or -1. visible may be null (all shown).
 */
export function hitTest(
  v: View,
  positions: Float32Array,
  radius: Float32Array,
  n: number,
  visible: Uint8Array | null,
  sx: number,
  sy: number,
): number {
  const w = toWorld(v, sx, sy);
  const tol = 3 / v.k;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    if (visible && !visible[i]) continue;
    const dx = (positions[2 * i] as number) - w.x;
    const dy = (positions[2 * i + 1] as number) - w.y;
    const r = (radius[i] as number) + tol;
    const d = dx * dx + dy * dy;
    if (d <= r * r && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}
