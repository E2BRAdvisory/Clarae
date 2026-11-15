// What the mini-map draws for each element of the scene: a simplified shape, cheap enough to
// redraw thousands of them while the drawing changes. Pure: nothing here imports Excalidraw.
import { rotatedBox, union, type Box } from './geometry';

/** The fields of an Excalidraw element the mini-map reads. */
export interface MiniElement {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  isDeleted?: boolean;
  /** Linear elements and free-hand lines: their points, relative to (x, y). */
  points?: readonly (readonly [number, number])[];
}

export type Shape =
  | {
      kind: 'box' | 'ellipse' | 'diamond' | 'frame' | 'image' | 'text';
      x: number;
      y: number;
      w: number;
      h: number;
      angle: number;
      stroke: string;
      fill: string | null;
    }
  | {
      kind: 'path';
      /** Scene coordinates, x and y in turn. */
      points: number[];
      stroke: string;
      bounds: Box;
    };

/** Points kept of a line: a free-hand stroke has hundreds, the mini-map draws a few pixels of it. */
export const MAX_PATH_POINTS = 24;

const KINDS: Record<string, Exclude<Shape['kind'], 'path'>> = {
  ellipse: 'ellipse',
  diamond: 'diamond',
  frame: 'frame',
  magicframe: 'frame',
  image: 'image',
  text: 'text',
};

const color = (c: string | undefined): string | null => (c && c !== 'transparent' ? c : null);

function pathOf(e: MiniElement, stroke: string): Shape | null {
  const pts = e.points ?? [];
  if (pts.length < 2) return null;
  const step = Math.max(1, Math.ceil((pts.length - 1) / (MAX_PATH_POINTS - 1)));
  const cx = e.x + e.width / 2;
  const cy = e.y + e.height / 2;
  const cos = Math.cos(e.angle ?? 0);
  const sin = Math.sin(e.angle ?? 0);
  const points: number[] = [];
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const push = (p: readonly [number, number]): void => {
    // the element turns about the centre of its box
    const px = e.x + p[0] - cx;
    const py = e.y + p[1] - cy;
    const x = cx + px * cos - py * sin;
    const y = cy + px * sin + py * cos;
    points.push(x, y);
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  };
  for (let i = 0; i < pts.length - 1; i += step) push(pts[i]!);
  push(pts[pts.length - 1]!);
  return { kind: 'path', points, stroke, bounds: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } };
}

/** The shapes of a scene, in drawing order; `ink` colours what has no stroke colour of its own. */
export function shapesOf(elements: readonly MiniElement[], ink: string): Shape[] {
  const out: Shape[] = [];
  for (const e of elements) {
    if (e.isDeleted) continue;
    const stroke = color(e.strokeColor) ?? ink;
    if (e.points) {
      const path = pathOf(e, stroke);
      if (path) out.push(path);
      continue;
    }
    out.push({
      kind: KINDS[e.type] ?? 'box',
      x: e.x,
      y: e.y,
      w: e.width,
      h: e.height,
      angle: e.angle ?? 0,
      stroke,
      fill: color(e.backgroundColor),
    });
  }
  return out;
}

/** The box around every shape; null for an empty drawing. */
export function boundsOf(shapes: readonly Shape[]): Box | null {
  let all: Box | null = null;
  for (const s of shapes)
    all = union(all, s.kind === 'path' ? s.bounds : rotatedBox(s.x, s.y, s.w, s.h, s.angle));
  return all;
}
