// Layout group of the script library: spacing, distances, rectangle expansion, dimensions,
// golden ratio and image grids. Each is a pure function of the selection (see types.ts).
import { arrangeable, num, PatchBuilder } from './geometry';
import type { ParamSpec, SceneAction, SceneContext, SceneElement } from './types';

type Axis = 'x' | 'y';
const size = (axis: Axis): 'width' | 'height' => (axis === 'x' ? 'width' : 'height');

const gapParam: ParamSpec = { key: 'gap', default: 20 };

/** Keeps the first element (by position) and chains the others after it with a fixed gap. */
function fixedSpacing(axis: Axis, id: string): SceneAction {
  return {
    id,
    group: 'layout',
    needs: 2,
    params: [gapParam],
    run(ctx) {
      const gap = ctx.params?.gap ?? 20;
      const pb = new PatchBuilder(ctx);
      const els = arrangeable(ctx).sort((a, b) => num(a, axis) - num(b, axis));
      let cursor = num(els[0] as SceneElement, axis);
      for (const e of els) {
        const g = pb.at(e);
        if (axis === 'x') pb.moveTo(e, cursor, g.y);
        else pb.moveTo(e, g.x, cursor);
        cursor += g[size(axis)] + gap;
      }
      return pb.build();
    },
  };
}

/** Spaces the centers of the elements by a fixed distance, the first one staying in place. */
function fixedCenterDistance(axis: Axis, id: string): SceneAction {
  return {
    id,
    group: 'layout',
    needs: 2,
    params: [{ key: 'distance', default: 150 }],
    run(ctx) {
      const distance = ctx.params?.distance ?? 150;
      const pb = new PatchBuilder(ctx);
      const center = (e: SceneElement): number => num(e, axis) + num(e, size(axis)) / 2;
      const els = arrangeable(ctx).sort((a, b) => center(a) - center(b));
      const first = center(els[0] as SceneElement);
      els.forEach((e, i) => {
        const g = pb.at(e);
        const target = first + i * distance - g[size(axis)] / 2;
        if (axis === 'x') pb.moveTo(e, target, g.y);
        else pb.moveTo(e, g.x, target);
      });
      return pb.build();
    },
  };
}

/** Makes every selected rectangle as wide (or tall) as the largest, anchored top-left. */
function expandRectangles(axis: Axis, keepTextCentered: boolean, id: string): SceneAction {
  return {
    id,
    group: 'layout',
    needs: 2,
    run(ctx) {
      const rects = arrangeable(ctx).filter((e) => e.type === 'rectangle');
      if (rects.length < 2) return { update: {} };
      const biggest = Math.max(...rects.map((e) => num(e, size(axis))));
      const pb = new PatchBuilder(ctx);
      for (const r of rects) {
        const g = pb.at(r);
        if (keepTextCentered) pb.setBox(r, { ...g, [size(axis)]: biggest });
        else {
          // The label keeps its own position: only the container changes.
          pb.setBoxKeepingText(r, { ...g, [size(axis)]: biggest });
        }
      }
      return pb.build();
    },
  };
}

const setDimensionsAndPosition: SceneAction = {
  id: 'set-dimensions-position',
  group: 'layout',
  needs: 1,
  params: ['x', 'y', 'width', 'height'].map<ParamSpec>((key) => ({
    key,
    default: (ctx: SceneContext) => {
      const e = ctx.elements.find((el) => ctx.selected[0] === el.id);
      return e ? Math.round(num(e, key)) : 0;
    },
    ...(key === 'width' || key === 'height' ? { min: 1 } : {}),
  })),
  run(ctx) {
    const first = ctx.elements.find((e) => ctx.selected[0] === e.id);
    const p = ctx.params;
    if (!first || !p) return { update: {} };
    const pb = new PatchBuilder(ctx);
    pb.setBox(first, {
      x: p.x ?? num(first, 'x'),
      y: p.y ?? num(first, 'y'),
      width: p.width ?? num(first, 'width'),
      height: p.height ?? num(first, 'height'),
    });
    return pb.build();
  },
};

const PHI = 1.618;

/** Gives every selected shape the golden ratio: the height becomes width / φ. */
const goldenRatio: SceneAction = {
  id: 'golden-ratio',
  group: 'layout',
  needs: 1,
  run(ctx) {
    const pb = new PatchBuilder(ctx);
    for (const e of arrangeable(ctx)) {
      if (!['rectangle', 'ellipse', 'diamond', 'image', 'frame'].includes(e.type)) continue;
      const g = pb.at(e);
      pb.setBox(e, { ...g, height: Math.round((g.width / PHI) * 100) / 100 });
    }
    return pb.build();
  },
};

/** Lays the selected images out in a grid of N columns, from the top-left image. */
const gridImages: SceneAction = {
  id: 'grid-images',
  group: 'layout',
  needs: 2,
  params: [{ key: 'columns', default: 3, min: 1 }, gapParam],
  run(ctx) {
    const cols = Math.max(1, Math.floor(ctx.params?.columns ?? 3));
    const gap = ctx.params?.gap ?? 20;
    const imgs = arrangeable(ctx).filter((e) => e.type === 'image');
    if (imgs.length < 2) return { update: {} };
    const ordered = [...imgs].sort(
      (a, b) => num(a, 'y') - num(b, 'y') || num(a, 'x') - num(b, 'x'),
    );
    const originX = Math.min(...ordered.map((e) => num(e, 'x')));
    const originY = Math.min(...ordered.map((e) => num(e, 'y')));
    const pb = new PatchBuilder(ctx);
    let y = originY;
    for (let row = 0; row < ordered.length; row += cols) {
      const cells = ordered.slice(row, row + cols);
      let x = originX;
      for (const e of cells) {
        pb.moveTo(e, x, y);
        x += num(e, 'width') + gap;
      }
      y += Math.max(...cells.map((e) => num(e, 'height'))) + gap;
    }
    return pb.build();
  },
};

export const LAYOUT_ACTIONS: readonly SceneAction[] = [
  fixedSpacing('x', 'fixed-spacing-horizontal'),
  fixedSpacing('y', 'fixed-spacing-vertical'),
  fixedCenterDistance('x', 'fixed-distance-centers-horizontal'),
  fixedCenterDistance('y', 'fixed-distance-centers-vertical'),
  expandRectangles('x', false, 'expand-rectangles-horizontal'),
  expandRectangles('x', true, 'expand-rectangles-horizontal-centered'),
  expandRectangles('y', false, 'expand-rectangles-vertical'),
  expandRectangles('y', true, 'expand-rectangles-vertical-centered'),
  setDimensionsAndPosition,
  goldenRatio,
  gridImages,
];
