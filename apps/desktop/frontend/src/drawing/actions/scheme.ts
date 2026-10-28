// "Color Scheme Manager" and "Organic Line" of the script library.
import { parseColor } from './color';
import { baseElement, styleOf } from './factory';
import type { Point } from './geometry';
import { selectedElements, type SceneAction, type SceneElement } from './types';

interface Scheme {
  value: number;
  name: string;
  stroke: readonly string[];
  fill: readonly string[];
}

export const COLOR_SCHEMES: readonly Scheme[] = [
  {
    value: 0,
    name: 'vivid',
    stroke: ['#1971c2', '#2f9e44', '#f08c00', '#e03131', '#9c36b5'],
    fill: ['#a5d8ff', '#b2f2bb', '#ffec99', '#ffc9c9', '#eebefa'],
  },
  {
    value: 1,
    name: 'pastel',
    stroke: ['#364fc7', '#0b7285', '#2b8a3e', '#e67700', '#c92a2a'],
    fill: ['#dbe4ff', '#c5f6fa', '#d3f9d8', '#fff3bf', '#ffe3e3'],
  },
  {
    value: 2,
    name: 'mono',
    stroke: ['#1e1e1e', '#495057', '#868e96'],
    fill: ['#f1f3f5', '#dee2e6', '#ced4da'],
  },
  {
    value: 3,
    name: 'earth',
    stroke: ['#5f3b1f', '#2b5f3a', '#7a4e1d', '#6b2d2d'],
    fill: ['#f3e5d0', '#d8e8d2', '#f0d9a8', '#e8cfcf'],
  },
];

/**
 * Re-colors the selection with a scheme: every distinct stroke color (and, apart, every distinct
 * background) is replaced by the next color of the scheme, in order of first appearance, so the
 * relationships between colors are kept. Transparent and non-hex colors are left alone.
 */
const colorScheme: SceneAction = {
  id: 'apply-color-scheme',
  group: 'style',
  needs: 1,
  params: [
    {
      key: 'scheme',
      default: 0,
      options: COLOR_SCHEMES.map((s) => ({
        value: s.value,
        labelKey: `drawing.options.scheme_${s.name}`,
      })),
    },
  ],
  run(ctx) {
    const scheme = COLOR_SCHEMES.find((s) => s.value === ctx.params?.scheme) ?? COLOR_SCHEMES[0];
    if (!scheme) return {};
    const strokes = new Map<string, string>();
    const fills = new Map<string, string>();
    const map = (table: Map<string, string>, palette: readonly string[], c: unknown) => {
      if (typeof c !== 'string' || !parseColor(c)) return null;
      const key = c.toLowerCase();
      if (!table.has(key)) table.set(key, palette[table.size % palette.length] as string);
      return table.get(key) as string;
    };
    const update: Record<string, Record<string, unknown>> = {};
    for (const e of selectedElements(ctx)) {
      const props: Record<string, unknown> = {};
      const s = map(strokes, scheme.stroke, e.strokeColor);
      const f = map(fills, scheme.fill, e.backgroundColor);
      if (s && s !== e.strokeColor) props.strokeColor = s;
      if (f && f !== e.backgroundColor) props.backgroundColor = f;
      if (Object.keys(props).length) update[e.id] = props;
    }
    return { update };
  },
};

/** Points along a polyline every `step` units, ends included. */
export function resample(points: readonly Point[], step: number): Point[] {
  const out: Point[] = points.length ? [[...(points[0] as Point)] as Point] : [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i] as Point;
    const [x2, y2] = points[i + 1] as Point;
    const n = Math.max(1, Math.round(Math.hypot(x2 - x1, y2 - y1) / step));
    for (let k = 1; k <= n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  }
  return out;
}

/** "Organic Line": a line becomes a hand-drawn stroke that tapers at both ends. */
const organicLine: SceneAction = {
  id: 'organic-line',
  group: 'shapes',
  needs: 1,
  run(ctx) {
    const add: SceneElement[] = [];
    const remove: string[] = [];
    for (const e of selectedElements(ctx).filter(
      (s) => s.type === 'line' && Array.isArray(s.points) && s.points.length >= 2,
    )) {
      const pts = resample(e.points as Point[], 6);
      const last = Math.max(1, pts.length - 1);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      add.push(
        baseElement(
          'freedraw',
          {
            x: Number(e.x) || 0,
            y: Number(e.y) || 0,
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          },
          {
            ...styleOf(e),
            points: pts,
            pressures: pts.map((_, i) => 0.25 + 0.75 * Math.sin((Math.PI * i) / last)),
            simulatePressure: false,
            lastCommittedPoint: null,
            groupIds: e.groupIds ?? [],
          },
        ),
      );
      remove.push(e.id);
    }
    return add.length ? { add, remove } : {};
  },
};

export const SCHEME_ACTIONS: readonly SceneAction[] = [colorScheme, organicLine];
