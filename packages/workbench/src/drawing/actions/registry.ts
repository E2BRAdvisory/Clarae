import { resetLatexSize } from '../latex/actions';
import { ARROW_ACTIONS } from './arrows';
import { autoLayout } from './autolayout';
import { GENERATOR_ACTIONS } from './generators';
import { SCHEME_ACTIONS } from './scheme';
import { LAYOUT_ACTIONS } from './layout';
import { MISC_ACTIONS } from './misc';
import { TEXT_ACTIONS } from './text';
import { VIEW_ACTIONS } from './view';
import { SHAPE_ACTIONS } from './shapes';
import { STYLE_ACTIONS } from './style';
import { selectedElements, type SceneAction, type SceneElement } from './types';

/** Selected elements of the given types, as the scripts that act "on selected arrows" do. */
function ofType(ctx: Parameters<SceneAction['run']>[0], ...types: string[]): SceneElement[] {
  return selectedElements(ctx).filter((e) => types.includes(e.type));
}

type Point = [number, number];

/** "Reverse arrows": swaps the two ends of every selected arrow. */
const reverseArrows: SceneAction = {
  id: 'reverse-arrows',
  group: 'arrows',
  needs: 1,
  run(ctx) {
    const update: Record<string, Record<string, unknown>> = {};
    for (const a of ofType(ctx, 'arrow')) {
      const pts = a.points as Point[] | undefined;
      if (!pts || pts.length < 2) continue;
      const last = pts[pts.length - 1] ?? [0, 0];
      // Points are relative to (x, y): re-anchor on the old end so the arrow stays in place.
      const reversed = [...pts].reverse().map(([px, py]): Point => [px - last[0], py - last[1]]);
      update[a.id] = {
        x: (a.x as number) + last[0],
        y: (a.y as number) + last[1],
        points: reversed,
        startArrowhead: a.endArrowhead ?? null,
        endArrowhead: a.startArrowhead ?? null,
        startBinding: a.endBinding ?? null,
        endBinding: a.startBinding ?? null,
      };
    }
    return { update };
  },
};

/** "Bullet points": prefixes every selected text with "• " (idempotent). */
const bulletPoints: SceneAction = {
  id: 'bullet-points',
  group: 'text',
  needs: 1,
  run(ctx) {
    const update: Record<string, Record<string, unknown>> = {};
    for (const t of ofType(ctx, 'text')) {
      const text = typeof t.text === 'string' ? t.text : '';
      if (text.startsWith('• ')) continue;
      const original = typeof t.originalText === 'string' ? t.originalText : text;
      update[t.id] = { text: `• ${text}`, originalText: `• ${original}` };
    }
    return { update };
  },
};

/** "Set stroke width": steps the stroke of the selection through Excalidraw's 1/2/4 widths. */
const cycleStrokeWidth: SceneAction = {
  id: 'cycle-stroke-width',
  group: 'style',
  needs: 1,
  run(ctx) {
    const steps = [1, 2, 4];
    const update: Record<string, Record<string, unknown>> = {};
    for (const e of selectedElements(ctx)) {
      if (typeof e.strokeWidth !== 'number') continue;
      const next = steps[(steps.indexOf(e.strokeWidth) + 1) % steps.length] ?? steps[0];
      update[e.id] = { strokeWidth: next };
    }
    return { update };
  },
};

export const SCENE_ACTIONS: readonly SceneAction[] = [
  ...LAYOUT_ACTIONS,
  autoLayout,
  ...STYLE_ACTIONS,
  ...SHAPE_ACTIONS,
  ...ARROW_ACTIONS,
  ...TEXT_ACTIONS,
  ...MISC_ACTIONS,
  ...VIEW_ACTIONS,
  ...GENERATOR_ACTIONS,
  ...SCHEME_ACTIONS,
  resetLatexSize,
  reverseArrows,
  bulletPoints,
  cycleStrokeWidth,
];

export function actionById(id: string): SceneAction | undefined {
  return SCENE_ACTIONS.find((a) => a.id === id);
}
