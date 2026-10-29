// Style group of the script library: background lightness/opacity, color inversion, stroke
// width, font family and text alignment. Colors that are not hex (e.g. "transparent") are left
// as they are, and elements that would not change are not touched (no version bump, no save).
import { invertColor, shiftLightness, withAlpha } from './color';
import { selectedElements, type SceneAction, type SceneContext, type SceneElement } from './types';

type Props = Record<string, unknown>;

/** Builds a patch from a per-element function returning the changed props (or null). */
function perElement(
  ctx: SceneContext,
  pick: (e: SceneElement) => boolean,
  change: (e: SceneElement) => Props | null,
): { update: Record<string, Props> } {
  const update: Record<string, Props> = {};
  for (const e of selectedElements(ctx)) {
    if (!pick(e)) continue;
    const props = change(e);
    if (!props) continue;
    const differs = Object.entries(props).some(([k, v]) => e[k] !== v);
    if (differs) update[e.id] = props;
  }
  return { update };
}

const anyElement = (): boolean => true;
const isText = (e: SceneElement): boolean => e.type === 'text';

/** Moves the lightness of the background of every selected element. */
function shiftBackground(id: string, sign: 1 | -1): SceneAction {
  return {
    id,
    group: 'style',
    needs: 1,
    params: [{ key: 'percent', default: 10, min: 0 }],
    run(ctx) {
      const delta = (sign * Math.min(100, ctx.params?.percent ?? 10)) / 100;
      return perElement(ctx, anyElement, (e) => {
        const next = shiftLightness(e.backgroundColor, delta);
        return next ? { backgroundColor: next } : null;
      });
    },
  };
}

const backgroundOpacity: SceneAction = {
  id: 'background-opacity',
  group: 'style',
  needs: 1,
  params: [{ key: 'opacityPercent', default: 100, min: 0 }],
  run(ctx) {
    const alpha = Math.min(100, ctx.params?.opacityPercent ?? 100) / 100;
    return perElement(ctx, anyElement, (e) => {
      const next = withAlpha(e.backgroundColor, alpha);
      return next ? { backgroundColor: next } : null;
    });
  },
};

/** Inverts stroke and background colors, for light ↔ dark conversions of a drawing. */
const invertColors: SceneAction = {
  id: 'invert-colors',
  group: 'style',
  needs: 1,
  run: (ctx) =>
    perElement(ctx, anyElement, (e) => {
      const stroke = invertColor(e.strokeColor);
      const bg = invertColor(e.backgroundColor);
      const props: Props = {};
      if (stroke) props.strokeColor = stroke;
      if (bg) props.backgroundColor = bg;
      return Object.keys(props).length ? props : null;
    }),
};

const setStrokeWidth: SceneAction = {
  id: 'set-stroke-width',
  group: 'style',
  needs: 1,
  params: [{ key: 'strokeWidth', default: 2, min: 0.5 }],
  run(ctx) {
    const width = ctx.params?.strokeWidth ?? 2;
    return perElement(
      ctx,
      (e) => typeof e.strokeWidth === 'number',
      () => ({ strokeWidth: width }),
    );
  },
};

/** Font family ids of Excalidraw 0.18. */
export const FONT_FAMILIES = [
  { value: 5, label: 'Excalifont' },
  { value: 1, label: 'Virgil' },
  { value: 6, label: 'Nunito' },
  { value: 7, label: 'Lilita One' },
  { value: 8, label: 'Comic Shanns' },
  { value: 2, label: 'Helvetica' },
  { value: 9, label: 'Liberation Sans' },
  { value: 3, label: 'Cascadia' },
] as const;

const setFontFamily: SceneAction = {
  id: 'set-font-family',
  group: 'style',
  needs: 1,
  params: [{ key: 'fontFamily', default: 5, options: FONT_FAMILIES }],
  run(ctx) {
    const family = ctx.params?.fontFamily ?? 5;
    return perElement(ctx, isText, () => ({ fontFamily: family }));
  },
};

export const TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const;

const setTextAlignment: SceneAction = {
  id: 'set-text-alignment',
  group: 'style',
  needs: 1,
  params: [
    {
      key: 'textAlign',
      default: 0,
      options: TEXT_ALIGNMENTS.map((a, value) => ({ value, labelKey: `drawing.options.${a}` })),
    },
  ],
  run(ctx) {
    const align = TEXT_ALIGNMENTS[ctx.params?.textAlign ?? 0] ?? 'left';
    return perElement(ctx, isText, () => ({ textAlign: align }));
  },
};

export const STYLE_ACTIONS: readonly SceneAction[] = [
  shiftBackground('darken-background', -1),
  shiftBackground('lighten-background', 1),
  backgroundOpacity,
  invertColors,
  setStrokeWidth,
  setFontFamily,
  setTextAlignment,
];
