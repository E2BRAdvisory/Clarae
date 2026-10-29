// Shapes group of the script library: boxes and ellipses around the selection, and changing a
// shape's type. New elements are skeletons (see factory.ts); the editor completes them.
import { arrangeable } from './geometry';
import { BOOLEAN_ACTIONS } from './boolean';
import { baseElement, boundsOf, type Box } from './factory';
import type { ParamSpec, SceneAction, SceneContext, SceneElement } from './types';

const SHAPES = ['rectangle', 'ellipse', 'diamond'] as const;
const paddingParam: ParamSpec = { key: 'padding', default: 20, min: 0 };

/** Selected elements that make up the content (labels are inside their container's box). */
const content = (ctx: SceneContext): SceneElement[] => arrangeable(ctx);

function pad(b: Box, p: number): Box {
  return { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p };
}

const topGroup = (e: SceneElement): string | null => {
  const g = e.groupIds;
  return Array.isArray(g) && g.length > 0 ? String(g[g.length - 1]) : null;
};

/** A rectangle around the whole selection. */
const boxSelected: SceneAction = {
  id: 'box-selected-elements',
  group: 'shapes',
  needs: 1,
  params: [paddingParam],
  run(ctx) {
    const b = boundsOf(content(ctx));
    if (!b) return {};
    return {
      add: [
        baseElement('rectangle', pad(b, ctx.params?.padding ?? 20), { roundness: { type: 3 } }),
      ],
    };
  },
};

/** One rectangle around each selected group. */
const boxEachGroup: SceneAction = {
  id: 'box-each-selected-group',
  group: 'shapes',
  needs: 1,
  params: [paddingParam],
  run(ctx) {
    const groups = new Map<string, SceneElement[]>();
    for (const e of content(ctx)) {
      const g = topGroup(e);
      if (g) groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    const p = ctx.params?.padding ?? 20;
    const add = [...groups.values()].map((els) =>
      baseElement('rectangle', pad(boundsOf(els) as Box, p), { roundness: { type: 3 } }),
    );
    return add.length ? { add } : {};
  },
};

/** An ellipse that circumscribes the selection. */
const ellipseAround: SceneAction = {
  id: 'ellipse-selected-elements',
  group: 'shapes',
  needs: 1,
  params: [paddingParam],
  run(ctx) {
    const b = boundsOf(content(ctx));
    if (!b) return {};
    const p = ctx.params?.padding ?? 20;
    // An ellipse through the corners of a w×h box has semi-axes (w/2)·√2 and (h/2)·√2.
    const w = (b.width / 2 + p) * Math.SQRT2 * 2;
    const h = (b.height / 2 + p) * Math.SQRT2 * 2;
    return {
      add: [
        baseElement('ellipse', {
          x: b.x + b.width / 2 - w / 2,
          y: b.y + b.height / 2 - h / 2,
          width: w,
          height: h,
        }),
      ],
    };
  },
};

/** Turns selected rectangles, ellipses and diamonds into another of those shapes. */
const changeShape: SceneAction = {
  id: 'change-shape',
  group: 'shapes',
  needs: 1,
  params: [
    {
      key: 'shape',
      default: 0,
      options: SHAPES.map((s, value) => ({ value, labelKey: `drawing.options.${s}` })),
    },
  ],
  run(ctx) {
    const target = SHAPES[ctx.params?.shape ?? 0] ?? 'rectangle';
    const update: Record<string, Record<string, unknown>> = {};
    for (const e of content(ctx)) {
      if (!(SHAPES as readonly string[]).includes(e.type) || e.type === target) continue;
      update[e.id] = { type: target, roundness: target === 'rectangle' ? { type: 3 } : null };
    }
    return { update };
  },
};

export const SHAPE_ACTIONS: readonly SceneAction[] = [
  boxSelected,
  boxEachGroup,
  ellipseAround,
  changeShape,
  ...BOOLEAN_ACTIONS,
];
