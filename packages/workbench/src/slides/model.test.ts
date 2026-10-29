import { describe, expect, it } from 'vitest';
import { parseSlides } from '@memobrain/markdown';
import { slideIndexAtLine, slideTitle } from './model';

const deck = parseSlides('---\ntitle: x\n---\n# One\n\ntext\n\n---\n\n# Two\n\n---\n\n# Three\n');
// slides start at lines 4, 10 and 14

describe('slideIndexAtLine', () => {
  it('finds the slide that holds a line, and the first one before the deck starts', () => {
    expect(deck.slides.map((s) => s.line)).toEqual([4, 10, 14]);
    expect(slideIndexAtLine(deck, 1)).toBe(0); // frontmatter
    expect(slideIndexAtLine(deck, 4)).toBe(0);
    expect(slideIndexAtLine(deck, 8)).toBe(0); // the separator belongs to the slide before it
    expect(slideIndexAtLine(deck, 10)).toBe(1);
    expect(slideIndexAtLine(deck, 99)).toBe(2);
  });

  it('is 0 for an empty deck', () => {
    expect(slideIndexAtLine(parseSlides(''), 5)).toBe(0);
  });
});

describe('slideTitle', () => {
  it('drops heading, list and quote marks and emphasis, and shortens long lines', () => {
    expect(slideTitle({ line: 1, content: '\n## **Big** `idea`', notes: '' })).toBe('Big idea');
    expect(slideTitle({ line: 1, content: '- first point', notes: '' })).toBe('first point');
    expect(slideTitle({ line: 1, content: '> quoted', notes: '' })).toBe('quoted');
    expect(slideTitle({ line: 1, content: 'x'.repeat(100), notes: '' }, 10)).toBe('xxxxxxxxx…');
  });
});
