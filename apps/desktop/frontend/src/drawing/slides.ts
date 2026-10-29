// Slideshow: every frame of the drawing is a slide. The order is the explicit
// `customData.memobrain.slide` number when frames have one, else the frame names read as
// "natural" text (Slide 2 before Slide 10), else their position on the board (rows, then columns).
import type { SceneElement } from './actions/types';

export interface Slide {
  id: string;
  name: string;
  /** Presenter notes (`customData.memobrain.notes` of the frame). */
  notes: string;
  /** False when the frame is left out of the presentation (`customData.memobrain.slideHidden`). */
  included: boolean;
  /** The frame's version, to know when its thumbnail is stale. */
  version: number;
}

type Meta = Record<string, unknown>;
const metaOf = (e: SceneElement): Meta =>
  (e.customData as { memobrain?: Meta } | undefined)?.memobrain ?? {};

/**
 * The property changes that set (or, with `undefined`, clear) keys of a frame's `memobrain`
 * custom data, keeping the rest of `customData`.
 */
export function slideMetaUpdate(
  e: SceneElement,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const memobrain: Meta = { ...metaOf(e) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || v === '' || v === false) delete memobrain[k];
    else memobrain[k] = v;
  }
  return { customData: { ...(e.customData as Meta | undefined), memobrain } };
}

/** Patch that numbers the frames 1..n in the given order (only those whose number changes). */
export function reorderUpdate(
  elements: readonly SceneElement[],
  order: readonly string[],
): Record<string, Record<string, unknown>> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const update: Record<string, Record<string, unknown>> = {};
  order.forEach((id, i) => {
    const e = byId.get(id);
    if (e && slideNumber(e) !== i + 1) update[id] = slideMetaUpdate(e, { slide: i + 1 });
  });
  return update;
}

/** The slides that are played (the others stay on the board and in the panel). */
export const playable = (slides: readonly Slide[]): Slide[] => slides.filter((s) => s.included);

/** The presenter notes stored on a frame. */
export const slideNotes = (e: SceneElement): string => {
  const mb = (e.customData as { memobrain?: { notes?: unknown } } | undefined)?.memobrain;
  return typeof mb?.notes === 'string' ? mb.notes : '';
};

const slideNumber = (e: SceneElement): number | null => {
  const mb = (e.customData as { memobrain?: { slide?: unknown } } | undefined)?.memobrain;
  return typeof mb?.slide === 'number' && Number.isFinite(mb.slide) ? mb.slide : null;
};

export function slidesOf(elements: readonly SceneElement[]): Slide[] {
  const frames = elements.filter((e) => e.type === 'frame' && !e.isDeleted);
  const name = (e: SceneElement): string => (typeof e.name === 'string' ? e.name.trim() : '');
  const num = (e: SceneElement, k: string): number => (typeof e[k] === 'number' ? e[k] : 0);
  const byPosition = (a: SceneElement, b: SceneElement): number =>
    num(a, 'y') - num(b, 'y') || num(a, 'x') - num(b, 'x');
  const sorted = [...frames].sort((a, b) => {
    const na = slideNumber(a);
    const nb = slideNumber(b);
    if (na !== null || nb !== null) {
      if (na === null) return 1; // numbered slides come first
      if (nb === null) return -1;
      if (na !== nb) return na - nb;
      return byPosition(a, b);
    }
    return (
      name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: 'base' }) ||
      byPosition(a, b)
    );
  });
  return sorted.map((e, i) => ({
    id: e.id,
    name: name(e) || `Frame ${i + 1}`,
    notes: slideNotes(e),
    included: metaOf(e)['slideHidden'] !== true,
    version: e.version,
  }));
}

/** The slide `step` away from `index`, stopping at the first and the last. */
export const moveSlide = (index: number, step: number, count: number): number =>
  Math.min(count - 1, Math.max(0, index + step));

/** The slide-show key bindings: the step a key asks for, `null` for "first"/"last", or undefined. */
export function slideKey(key: string): number | 'first' | 'last' | undefined {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
    case 'Enter':
      return 1;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
      return -1;
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return undefined;
  }
}
