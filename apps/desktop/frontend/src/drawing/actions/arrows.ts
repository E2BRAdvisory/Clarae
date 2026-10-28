// Arrows group of the script library: connecting shapes, orthogonal routes, straightening,
// connector points and "next step in a process". Arrow endpoints are points relative to the
// arrow's x, y; bound shapes list the arrow in `boundElements`.
import { arrangeable, extent, num, type Point } from './geometry';
import { arrowBetween, boundsOf, center, type Box } from './factory';
import { newId, newNonce } from './ids';
import { selectedElements, type SceneAction, type SceneContext, type SceneElement } from './types';

const isShape = (e: SceneElement): boolean =>
  ['rectangle', 'ellipse', 'diamond', 'image', 'frame', 'text'].includes(e.type);

const pointsOf = (a: SceneElement): Point[] | null =>
  Array.isArray(a.points) && a.points.length >= 2 ? (a.points as Point[]) : null;

const selectedArrows = (ctx: SceneContext): SceneElement[] =>
  selectedElements(ctx).filter((e) => e.type === 'arrow' && pointsOf(e));

type Update = Record<string, Record<string, unknown>>;

/** Arrows that join the selected shapes in reading order: a → b → c. */
const connectElements: SceneAction = {
  id: 'connect-elements',
  group: 'arrows',
  needs: 2,
  run(ctx) {
    const shapes = arrangeable(ctx)
      .filter(isShape)
      .sort((a, b) => {
        const ca = center(boundsOf([a]) as Box);
        const cb = center(boundsOf([b]) as Box);
        return ca.x - cb.x || ca.y - cb.y;
      });
    if (shapes.length < 2) return {};
    const add: SceneElement[] = [];
    const bound = new Map<string, unknown[]>();
    for (let i = 0; i + 1 < shapes.length; i++) {
      const a = shapes[i] as SceneElement;
      const b = shapes[i + 1] as SceneElement;
      const { arrow } = arrowBetween(a, b);
      add.push(arrow);
      for (const s of [a, b])
        bound.set(s.id, [...(bound.get(s.id) ?? []), { id: arrow.id, type: 'arrow' }]);
    }
    const update: Update = {};
    for (const [id, refs] of bound) {
      const el = shapes.find((s) => s.id === id) as SceneElement;
      update[id] = {
        boundElements: [
          ...(Array.isArray(el.boundElements) ? (el.boundElements as unknown[]) : []),
          ...refs,
        ],
      };
    }
    return { add, update };
  },
};

/** Re-routes arrows as right-angle connectors (a horizontal-vertical-horizontal "Z"). */
const elbowConnectors: SceneAction = {
  id: 'elbow-connectors',
  group: 'arrows',
  needs: 1,
  run(ctx) {
    const update: Update = {};
    for (const a of selectedArrows(ctx)) {
      const pts = pointsOf(a) as Point[];
      const [dx, dy] = pts[pts.length - 1] as Point;
      const next: Point[] =
        Math.abs(dx) >= Math.abs(dy)
          ? [
              [0, 0],
              [dx / 2, 0],
              [dx / 2, dy],
              [dx, dy],
            ]
          : [
              [0, 0],
              [0, dy / 2],
              [dx, dy / 2],
              [dx, dy],
            ];
      update[a.id] = { points: next, roundness: null, ...extent(next) };
    }
    return { update };
  },
};

/** Straightens arrows to the axis they mostly follow. */
const normalizeArrows: SceneAction = {
  id: 'normalize-arrows',
  group: 'arrows',
  needs: 1,
  run(ctx) {
    const update: Update = {};
    for (const a of selectedArrows(ctx)) {
      const pts = pointsOf(a) as Point[];
      const [dx, dy] = pts[pts.length - 1] as Point;
      const end: Point = Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
      const next: Point[] = [[0, 0], end];
      update[a.id] = { points: next, ...extent(next) };
    }
    return { update };
  },
};

/** Adds a vertex in the middle of the longest segment of each arrow, to bend it by hand. */
const addConnectorPoint: SceneAction = {
  id: 'add-connector-point',
  group: 'arrows',
  needs: 1,
  run(ctx) {
    const update: Update = {};
    for (const a of selectedArrows(ctx)) {
      const pts = pointsOf(a) as Point[];
      let at = 0;
      let longest = -1;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x1, y1] = pts[i] as Point;
        const [x2, y2] = pts[i + 1] as Point;
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len > longest) {
          longest = len;
          at = i;
        }
      }
      const [x1, y1] = pts[at] as Point;
      const [x2, y2] = pts[at + 1] as Point;
      const next = [
        ...pts.slice(0, at + 1),
        [(x1 + x2) / 2, (y1 + y2) / 2] as Point,
        ...pts.slice(at + 1),
      ];
      update[a.id] = { points: next };
    }
    return { update };
  },
};

/** A copy of each selected shape to its right, joined to it by an arrow. */
const addNextStep: SceneAction = {
  id: 'add-next-step',
  group: 'arrows',
  needs: 1,
  params: [{ key: 'gap', default: 80, min: 20 }],
  run(ctx) {
    const gap = ctx.params?.gap ?? 80;
    const add: SceneElement[] = [];
    const update: Update = {};
    for (const src of arrangeable(ctx).filter((e) =>
      ['rectangle', 'ellipse', 'diamond'].includes(e.type),
    )) {
      const copy: SceneElement = {
        ...src,
        id: newId(),
        x: num(src, 'x') + num(src, 'width') + gap,
        boundElements: null,
        groupIds: [],
        version: 1,
        versionNonce: newNonce(),
        index: null,
        seed: Math.floor(Math.random() * 2 ** 31),
      };
      const { arrow, update: u } = arrowBetween(src, copy);
      add.push(copy, arrow);
      // The new shape is not in the scene yet: only the source needs its boundElements updated.
      update[src.id] = u[src.id] as Record<string, unknown>;
      copy.boundElements = [{ id: arrow.id, type: 'arrow' }];
    }
    return add.length ? { add, update } : {};
  },
};

export const ARROW_ACTIONS: readonly SceneAction[] = [
  connectElements,
  elbowConnectors,
  normalizeArrows,
  addConnectorPoint,
  addNextStep,
];
