// The geometry of the mini-map: scene coordinates on one side, the pixels of the little picture
// on the other. Pure, so the mapping is tested without a canvas.

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What Excalidraw's state says about the view: scroll, zoom and the size of the canvas in px. */
export interface View {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
}

/** Scene → mini-map: `p * scale + (dx, dy)`. */
export interface Transform {
  scale: number;
  dx: number;
  dy: number;
}

/** The part of the scene on screen. */
export function visibleBox(v: View): Box {
  return { x: -v.scrollX, y: -v.scrollY, w: v.width / v.zoom, h: v.height / v.zoom };
}

/** The upright box around a `w`×`h` rectangle at (`x`, `y`) turned by `angle` about its centre. */
export function rotatedBox(x: number, y: number, w: number, h: number, angle: number): Box {
  if (!angle) return { x, y, w, h };
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const bw = w * cos + h * sin;
  const bh = w * sin + h * cos;
  return { x: x + (w - bw) / 2, y: y + (h - bh) / 2, w: bw, h: bh };
}

export function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * What the mini-map shows: the drawing and the part on screen together, so the frame of the view
 * is always inside the picture, with a margin (a share of the longer side) around them.
 */
export function worldBounds(content: Box | null, view: Box, margin = 0.06): Box {
  const all = union(content, view) ?? view;
  const by = Math.max(all.w, all.h, 1) * margin;
  return { x: all.x - by, y: all.y - by, w: all.w + 2 * by, h: all.h + 2 * by };
}

/** Fits `world` in a picture of `size` pixels, centred, keeping its proportions. */
export function fitTransform(world: Box, size: { w: number; h: number }): Transform {
  const scale = Math.min(size.w / Math.max(world.w, 1e-6), size.h / Math.max(world.h, 1e-6));
  return {
    scale,
    dx: (size.w - world.w * scale) / 2 - world.x * scale,
    dy: (size.h - world.h * scale) / 2 - world.y * scale,
  };
}

export const toMini = (t: Transform, p: Point): Point => ({
  x: p.x * t.scale + t.dx,
  y: p.y * t.scale + t.dy,
});

export const toScene = (t: Transform, p: Point): Point => ({
  x: (p.x - t.dx) / t.scale,
  y: (p.y - t.dy) / t.scale,
});

export const miniBox = (t: Transform, b: Box): Box => ({
  ...toMini(t, b),
  w: b.w * t.scale,
  h: b.h * t.scale,
});

export const sameTransform = (a: Transform | null, b: Transform | null): boolean =>
  !!a && !!b && a.scale === b.scale && a.dx === b.dx && a.dy === b.dy;

/** The scroll that puts the scene point `center` in the middle of the view (zoom unchanged). */
export function scrollForCenter(
  center: Point,
  v: Pick<View, 'zoom' | 'width' | 'height'>,
): { scrollX: number; scrollY: number } {
  return {
    scrollX: v.width / 2 / v.zoom - center.x,
    scrollY: v.height / 2 / v.zoom - center.y,
  };
}

/** The scroll after moving the view by a share of what is on screen (`1`: a whole screen right/down). */
export function panBy(v: View, fx: number, fy: number): { scrollX: number; scrollY: number } {
  const box = visibleBox(v);
  return { scrollX: v.scrollX - box.w * fx, scrollY: v.scrollY - box.h * fy };
}
