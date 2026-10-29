// Boolean Operations and Split Ellipse of the script library, on polygons (polygon-clipping).
// Rectangles, diamonds, ellipses and closed lines are turned into rings, combined, and the
// result is drawn as closed `line` elements that take the style of the bottom-most shape.
import {
  difference,
  intersection,
  union,
  xor,
  type MultiPolygon,
  type Pair,
  type Ring,
} from 'polygon-clipping';
import { arrangeable, num } from './geometry';
import { baseElement } from './factory';
import type { SceneAction, SceneContext, SceneElement, ScenePatch } from './types';

const ELLIPSE_STEPS = 72;

function rotate(ring: Ring, cx: number, cy: number, angle: number): Ring {
  if (!angle) return ring;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return ring.map(([x, y]): Pair => [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos,
  ]);
}

/** The outline of a shape as a ring in scene coordinates, or null if it has no area. */
export function shapeRing(e: SceneElement): Ring | null {
  const x = num(e, 'x');
  const y = num(e, 'y');
  const w = num(e, 'width');
  const h = num(e, 'height');
  const cx = x + w / 2;
  const cy = y + h / 2;
  const angle = num(e, 'angle');
  let ring: Ring | null = null;
  if (e.type === 'rectangle' || e.type === 'frame') {
    ring = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
  } else if (e.type === 'diamond') {
    ring = [
      [cx, y],
      [x + w, cy],
      [cx, y + h],
      [x, cy],
    ];
  } else if (e.type === 'ellipse') {
    ring = Array.from({ length: ELLIPSE_STEPS }, (_, i): Pair => {
      const t = (i / ELLIPSE_STEPS) * Math.PI * 2;
      return [cx + (w / 2) * Math.cos(t), cy + (h / 2) * Math.sin(t)];
    });
  } else if ((e.type === 'line' || e.type === 'freedraw') && Array.isArray(e.points)) {
    const pts = (e.points as Pair[]).map(([px, py]): Pair => [x + px, y + py]);
    const first = pts[0];
    const last = pts[pts.length - 1];
    // Only closed outlines have an area.
    if (
      pts.length >= 4 &&
      first &&
      last &&
      Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6
    )
      ring = pts.slice(0, -1);
  }
  if (!ring || (Math.abs(w) < 1e-9 && Math.abs(h) < 1e-9)) return null;
  return rotate(ring, cx, cy, angle);
}

/** Signed area (shoelace); positive for counter-clockwise rings in a y-up system. */
export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i] as Pair;
    const [x2, y2] = ring[(i + 1) % ring.length] as Pair;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * One closed ring for a polygon with holes: each hole is joined to the outline by a zero-width
 * slit between their nearest vertices (an outline cannot have a hole, a slit makes it look like
 * one when it is filled).
 */
export function keyhole(polygon: Ring[]): Ring {
  let outer = polygon[0] as Ring;
  for (const hole of polygon.slice(1)) {
    let best = { i: 0, j: 0, d: Infinity };
    outer.forEach(([ox, oy], i) =>
      hole.forEach(([hx, hy], j) => {
        const d = (ox - hx) ** 2 + (oy - hy) ** 2;
        if (d < best.d) best = { i, j, d };
      }),
    );
    const around = [...hole.slice(best.j), ...hole.slice(0, best.j), hole[best.j] as Pair];
    outer = [...outer.slice(0, best.i + 1), ...around, ...outer.slice(best.i)];
  }
  return outer;
}

/** Closed `line` elements for a multipolygon, styled like `style`. */
export function linesFor(result: MultiPolygon, style: SceneElement): SceneElement[] {
  return result.map((polygon) => {
    const ring = keyhole(polygon);
    const closed: Pair[] = [...ring, ring[0] as Pair];
    const xs = closed.map((p) => p[0]);
    const ys = closed.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return baseElement(
      'line',
      { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
      {
        points: closed.map(([px, py]) => [px - x, py - y]),
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
        strokeColor: style.strokeColor ?? '#1e1e1e',
        backgroundColor: style.backgroundColor ?? 'transparent',
        fillStyle: style.fillStyle ?? 'solid',
        strokeWidth: style.strokeWidth ?? 2,
        strokeStyle: style.strokeStyle ?? 'solid',
        roughness: style.roughness ?? 1,
        opacity: style.opacity ?? 100,
      },
    );
  });
}

/** Selected shapes with an area, bottom-most first (the order they are drawn in). */
function shapesInOrder(ctx: SceneContext): { el: SceneElement; ring: Ring }[] {
  const picked = new Set(arrangeable(ctx).map((e) => e.id));
  return ctx.elements
    .filter((e) => picked.has(e.id))
    .map((el) => ({ el, ring: shapeRing(el) }))
    .filter((s): s is { el: SceneElement; ring: Ring } => s.ring !== null);
}

type Op = (geom: Ring[], ...geoms: Ring[][]) => MultiPolygon;

function booleanAction(id: string, op: Op): SceneAction {
  return {
    id,
    group: 'shapes',
    needs: 2,
    run(ctx): ScenePatch {
      const shapes = shapesInOrder(ctx);
      if (shapes.length < 2) return {};
      const [first, ...rest] = shapes as [(typeof shapes)[number], ...typeof shapes];
      const result = op([first.ring], ...rest.map((s) => [s.ring]));
      if (result.length === 0) return {};
      return { add: linesFor(result, first.el), remove: shapes.map((s) => s.el.id) };
    },
  };
}

const HALF = 1e7;

/** Splits an ellipse in two along a line through its center (angle in degrees, 0 = horizontal). */
const splitEllipse: SceneAction = {
  id: 'split-ellipse',
  group: 'shapes',
  needs: 1,
  params: [{ key: 'angle', default: 0 }],
  run(ctx) {
    const angle = ((ctx.params?.angle ?? 0) * Math.PI) / 180;
    const add: SceneElement[] = [];
    const remove: string[] = [];
    for (const e of arrangeable(ctx).filter((s) => s.type === 'ellipse')) {
      const ring = shapeRing(e);
      if (!ring) continue;
      const cx = num(e, 'x') + num(e, 'width') / 2;
      const cy = num(e, 'y') + num(e, 'height') / 2;
      // Two huge half planes meeting on the cutting line.
      const upper = rotate(
        [
          [cx - HALF, cy - HALF],
          [cx + HALF, cy - HALF],
          [cx + HALF, cy],
          [cx - HALF, cy],
        ],
        cx,
        cy,
        angle,
      );
      const lower = rotate(
        [
          [cx - HALF, cy],
          [cx + HALF, cy],
          [cx + HALF, cy + HALF],
          [cx - HALF, cy + HALF],
        ],
        cx,
        cy,
        angle,
      );
      for (const half of [upper, lower]) add.push(...linesFor(intersection([ring], [half]), e));
      remove.push(e.id);
    }
    return add.length ? { add, remove } : {};
  },
};

export const BOOLEAN_ACTIONS: readonly SceneAction[] = [
  booleanAction('boolean-union', union),
  booleanAction('boolean-intersection', intersection),
  booleanAction('boolean-difference', difference),
  booleanAction('boolean-xor', xor),
  splitEllipse,
];
