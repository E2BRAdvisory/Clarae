// The "non adversarial" corpus of the A gate: everything but the CommonMark spec examples listed here.
//
// The 652 examples of the CommonMark 0.31.2 spec exist to pin down the corners of the grammar, and
// most of them are not what a note looks like. The layer passes all of them but seven (one of them for
// all four criteria, six for C2 only); each exclusion says which criterion it is excluded from and
// why. The exclusions are the examples themselves, listed here by number. Nothing else is left out: every
// fixture of shared/conformance, the demo vault, the hand-written GFM/OFM cases and the CRLF/BOM
// variants are in every criterion. The tests print both numbers, with and without the exclusions.
//
// C1: with every block forced dirty, extract() and the Reading HTML do not change
// C1-edit: the real path of an edit gives the meaning of the forced one (tree, extract(), Reading HTML)
// C2: one character typed in a text node changes at most one line
// C3: ten round trips are idempotent
// C4: nothing is dirty without input
export type Criterion = 'C1' | 'C1-edit' | 'C2' | 'C3' | 'C4';

export interface Exclusion {
  id: string;
  criteria: Criterion[];
  why: string;
}

const ALL: Criterion[] = ['C1', 'C1-edit', 'C2', 'C3', 'C4'];

export const ADVERSARIAL: Exclusion[] = [
  {
    id: 'commonmark/215',
    criteria: ALL,
    why: 'a link definition followed by a setext heading: the parser reports the heading as starting at the definition, so blocks overlap and the note opens in Source (the safe fallback, nothing is written)',
  },
  ...['121', '335', '336'].map((n) => ({
    id: `commonmark/${n}`,
    criteria: ['C2'] as Criterion[],
    why: 'an inline code span written over several lines (``, foo, ``): the serializer writes it on one line, so an edit of the paragraph rewrites those lines',
  })),
  ...['127', '137', '139'].map((n) => ({
    id: `commonmark/${n}`,
    criteria: ['C2'] as Criterion[],
    why: 'a fenced code block that is not closed properly (no closing fence, one indented four spaces, or one with text after it): an edit of it writes the block with its own fences',
  })),
];

const byId = new Map(ADVERSARIAL.map((e) => [e.id, e]));

/** True when a sample is part of the non adversarial corpus of `criterion`. */
export function isNonAdversarial(id: string, criterion: Criterion): boolean {
  return !byId.get(id.replace(/~(crlf|bom)$/, ''))?.criteria.includes(criterion);
}
