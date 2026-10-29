// Builders for brand new elements. They are skeletons: the editor completes them with
// Excalidraw's restoreElements (index, defaults) before they join the scene.
import { newId, newNonce } from './ids';
import type { SceneElement } from './types';

type Props = Record<string, unknown>;

/** A new element with Excalidraw's defaults, `extra` overriding them. */
export function baseElement(
  type: string,
  box: { x: number; y: number; width: number; height: number },
  extra: Props = {},
): SceneElement {
  return {
    id: newId(),
    type,
    ...box,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: null,
    link: null,
    locked: false,
    index: null,
    isDeleted: false,
    version: 1,
    versionNonce: newNonce(),
    ...extra,
  };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of elements (x/y/width/height; rotation is ignored). */
export function boundsOf(els: readonly SceneElement[]): Box | null {
  if (els.length === 0) return null;
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const e of els) {
    const x = Number(e.x) || 0;
    const y = Number(e.y) || 0;
    const w = Number(e.width) || 0;
    const h = Number(e.height) || 0;
    l = Math.min(l, x, x + w);
    t = Math.min(t, y, y + h);
    r = Math.max(r, x, x + w);
    b = Math.max(b, y, y + h);
  }
  return { x: l, y: t, width: r - l, height: b - t };
}

export const center = (b: Box): { x: number; y: number } => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

/** Where the ray from the center of `box` toward (tx, ty) leaves the shape. */
export function edgePoint(
  box: Box,
  shape: 'rect' | 'ellipse' | 'diamond',
  tx: number,
  ty: number,
): { x: number; y: number } {
  const c = center(box);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = box.width / 2;
  const hh = box.height / 2;
  let t: number;
  if (shape === 'ellipse') t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (shape === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else
    t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

export const shapeKind = (e: SceneElement): 'rect' | 'ellipse' | 'diamond' =>
  e.type === 'ellipse' ? 'ellipse' : e.type === 'diamond' ? 'diamond' : 'rect';

/** Excalidraw's binding of an arrow end: the point on the shape's outline as a ratio of its box. */
function bindingAt(elementId: string, box: Box, p: { x: number; y: number }) {
  const ratio = (v: number, size: number) => (size > 0 ? Math.min(1, Math.max(0, v / size)) : 0.5);
  return {
    elementId,
    fixedPoint: [ratio(p.x - box.x, box.width), ratio(p.y - box.y, box.height)],
    mode: 'orbit',
  };
}

/**
 * An arrow from `a` to `b`, attached to both (the endpoints sit on the shapes' outlines), plus
 * the `boundElements` updates the two shapes need for Excalidraw to treat the arrow as bound.
 */
export function arrowBetween(
  a: SceneElement,
  b: SceneElement,
  style: Props = {},
): { arrow: SceneElement; update: Record<string, Props> } {
  const ab = boundsOf([a]) as Box;
  const bb = boundsOf([b]) as Box;
  const cb = center(bb);
  const ca = center(ab);
  const start = edgePoint(ab, shapeKind(a), cb.x, cb.y);
  const end = edgePoint(bb, shapeKind(b), ca.x, ca.y);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const arrow = baseElement(
    'arrow',
    { x: start.x, y: start.y, width: Math.abs(dx), height: Math.abs(dy) },
    {
      points: [
        [0, 0],
        [dx, dy],
      ],
      lastCommittedPoint: null,
      startBinding: bindingAt(a.id, ab, start),
      endBinding: bindingAt(b.id, bb, end),
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
      roundness: { type: 2 },
      ...style,
    },
  );
  const bound = (e: SceneElement): Props => ({
    boundElements: [
      ...(Array.isArray(e.boundElements) ? (e.boundElements as unknown[]) : []),
      { id: arrow.id, type: 'arrow' },
    ],
  });
  return { arrow, update: { [a.id]: bound(a), [b.id]: bound(b) } };
}

/** Style properties a copy of an element should keep. */
const STYLE_KEYS = [
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
] as const;

export function styleOf(e: SceneElement): Props {
  const out: Props = {};
  for (const k of STYLE_KEYS) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

/** A free text element; width and height are estimates Excalidraw re-measures. */
export function textElement(
  text: string,
  at: { x: number; y: number },
  from: SceneElement,
  extra: Props = {},
): SceneElement {
  const fontSize = typeof from.fontSize === 'number' ? from.fontSize : 20;
  const lines = text.split('\n');
  return baseElement(
    'text',
    {
      x: at.x,
      y: at.y,
      width: Math.max(...lines.map((l) => l.length), 1) * fontSize * 0.6,
      height: lines.length * fontSize * 1.25,
    },
    {
      ...styleOf(from),
      text,
      originalText: text,
      fontSize,
      fontFamily: typeof from.fontFamily === 'number' ? from.fontFamily : 5,
      textAlign: typeof from.textAlign === 'string' ? from.textAlign : 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
      ...extra,
    },
  );
}

/**
 * Copies of `els` moved by (dx, dy), with new ids. Containers and their bound text are copied
 * together and re-linked; groups are copied as new groups; arrows and bindings are dropped (a copy
 * must not steal the original's attachments).
 */
export function cloneElements(
  els: readonly SceneElement[],
  all: readonly SceneElement[],
  dx: number,
  dy: number,
): SceneElement[] {
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  const withLabels = [...els];
  for (const e of all)
    if (
      e.type === 'text' &&
      typeof e.containerId === 'string' &&
      els.some((c) => c.id === e.containerId) &&
      !els.includes(e) &&
      !e.isDeleted
    )
      withLabels.push(e);
  for (const e of withLabels) ids.set(e.id, newId());
  return withLabels.map((e) => ({
    ...e,
    id: ids.get(e.id) as string,
    x: (Number(e.x) || 0) + dx,
    y: (Number(e.y) || 0) + dy,
    groupIds: (Array.isArray(e.groupIds) ? (e.groupIds as string[]) : []).map((g) => {
      if (!groups.has(g)) groups.set(g, newId());
      return groups.get(g) as string;
    }),
    containerId: typeof e.containerId === 'string' ? (ids.get(e.containerId) ?? null) : null,
    boundElements: Array.isArray(e.boundElements)
      ? (e.boundElements as { id: string; type: string }[])
          .filter((b) => b.type === 'text' && ids.has(b.id))
          .map((b) => ({ id: ids.get(b.id) as string, type: 'text' }))
      : null,
    startBinding: null,
    endBinding: null,
    version: 1,
    versionNonce: newNonce(),
    seed: Math.floor(Math.random() * 2 ** 31),
    index: null,
    isDeleted: false,
  }));
}
