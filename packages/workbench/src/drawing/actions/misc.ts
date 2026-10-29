// Utilities of the script library: repeat elements, simplify a freehand stroke into a line.
import { arrangeable, type Point } from './geometry';
import { baseElement, cloneElements, styleOf } from './factory';
import type { SceneAction, SceneElement } from './types';

/** "Repeat Elements": N copies of the selection, each moved by (dx, dy) from the previous one. */
const repeatElements: SceneAction = {
  id: 'repeat-elements',
  group: 'layout',
  needs: 1,
  params: [
    { key: 'copies', default: 3, min: 1 },
    { key: 'dx', default: 40 },
    { key: 'dy', default: 40 },
  ],
  run(ctx) {
    const copies = Math.min(100, Math.floor(ctx.params?.copies ?? 3));
    const dx = ctx.params?.dx ?? 40;
    const dy = ctx.params?.dy ?? 40;
    const base = arrangeable(ctx).filter((e) => e.type !== 'arrow');
    if (base.length === 0) return {};
    const add: SceneElement[] = [];
    for (let i = 1; i <= copies; i++)
      add.push(...cloneElements(base, ctx.elements, dx * i, dy * i));
    return { add };
  },
};

/** Ramer–Douglas–Peucker: the fewest points that stay within `epsilon` of the stroke. */
export function simplify(points: readonly Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.map(([x, y]): Point => [x, y]);
  const [x1, y1] = points[0] as Point;
  const [x2, y2] = points[points.length - 1] as Point;
  const len = Math.hypot(x2 - x1, y2 - y1);
  let far = 0;
  let at = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i] as Point;
    const d =
      len === 0
        ? Math.hypot(px - x1, py - y1)
        : Math.abs((y2 - y1) * px - (x2 - x1) * py + x2 * y1 - y2 * x1) / len;
    if (d > far) {
      far = d;
      at = i;
    }
  }
  if (far <= epsilon || at < 0)
    return [
      [x1, y1],
      [x2, y2],
    ];
  const left = simplify(points.slice(0, at + 1), epsilon);
  const right = simplify(points.slice(at), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** "Convert freedraw to line": the stroke becomes an editable line with few points. */
const freedrawToLine: SceneAction = {
  id: 'convert-freedraw-to-line',
  group: 'shapes',
  needs: 1,
  params: [{ key: 'tolerance', default: 2, min: 0 }],
  run(ctx) {
    const eps = ctx.params?.tolerance ?? 2;
    const add: SceneElement[] = [];
    const remove: string[] = [];
    for (const e of arrangeable(ctx).filter(
      (s) => s.type === 'freedraw' && Array.isArray(s.points),
    )) {
      const pts = simplify(e.points as Point[], eps);
      if (pts.length < 2) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const ox = Math.min(...xs);
      const oy = Math.min(...ys);
      add.push(
        baseElement(
          'line',
          {
            x: (Number(e.x) || 0) + ox,
            y: (Number(e.y) || 0) + oy,
            width: Math.max(...xs) - ox,
            height: Math.max(...ys) - oy,
          },
          {
            ...styleOf(e),
            points: pts.map(([px, py]) => [px - ox, py - oy]),
            lastCommittedPoint: null,
            startBinding: null,
            endBinding: null,
            startArrowhead: null,
            endArrowhead: null,
            groupIds: e.groupIds ?? [],
          },
        ),
      );
      remove.push(e.id);
    }
    return add.length ? { add, remove } : {};
  },
};

export const MISC_ACTIONS: readonly SceneAction[] = [repeatElements, freedrawToLine];
