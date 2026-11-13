import type { Slide, SlideDeck } from '@clarae/markdown';

/** Index of the slide that contains `line` (1-based file line): the last one that starts at or before it. */
export function slideIndexAtLine(deck: SlideDeck, line: number): number {
  let at = 0;
  deck.slides.forEach((s, i) => {
    if (s.line <= line) at = i;
  });
  return at;
}

/** A short label for a slide: its first line without Markdown heading/list/quote marks. */
export function slideTitle(slide: Slide, max = 60): string {
  const first = slide.content.split('\n').find((l) => l.trim() !== '') ?? '';
  const text = first
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/[*_`~=]/g, '')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
