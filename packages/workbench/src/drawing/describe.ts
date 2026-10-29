// A text description of a drawing, for people who cannot see the canvas (WCAG 1.1.1): what it
// contains, the frames in reading order, every text and every link.
import type { SceneElement } from './actions/types';
import { slidesOf } from './slides';

export interface Description {
  /** Live elements by type, most frequent first. */
  counts: { type: string; count: number }[];
  /** Frame names (slides) in presentation order. */
  frames: string[];
  /** Texts in reading order (top to bottom, then left to right). */
  texts: string[];
  /** Link targets of elements (`[[note]]`, URLs). */
  links: string[];
}

export function describeScene(elements: readonly SceneElement[]): Description {
  const live = elements.filter((e) => !e.isDeleted);
  const byType = new Map<string, number>();
  for (const e of live) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const num = (e: SceneElement, k: string): number => (typeof e[k] === 'number' ? e[k] : 0);
  const texts = live
    .filter((e) => e.type === 'text' && typeof e.text === 'string' && e.text.trim() !== '')
    .sort((a, b) => num(a, 'y') - num(b, 'y') || num(a, 'x') - num(b, 'x'))
    .map((e) => (e.text as string).trim());
  const links = [
    ...new Set(
      live.flatMap((e) => (typeof e.link === 'string' && e.link.trim() ? [e.link.trim()] : [])),
    ),
  ];
  return {
    counts: [...byType].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    frames: slidesOf(live).map((s) => s.name),
    texts,
    links,
  };
}
