import { scanInline, type BlockState } from '@clarae/markdown';
import { describe, expect, it } from 'vitest';
import { escapeOfmText } from './escape';

// The property tests of the escape invariant (B2) are testing/escapeSuite.ts, run by conformance.test.ts.

describe('escapeOfmText', () => {
  const state: BlockState = { inMath: false, inComment: false };

  it('leaves nothing for scanInline to find in what it returns (a tag, a comment, a block id)', () => {
    for (const text of ['#tag', ' #tag', 'x #a #b', '%%a%%', 'x ^id', '[[x]]']) {
      const out = escapeOfmText(text.replace(/\[/g, '\\['), '', '');
      const spans = scanInline(out, { ...state }).filter((s) =>
        ['tag', 'comment', 'blockId', 'wikilink'].includes(s.kind),
      );
      expect(spans, JSON.stringify([text, out])).toEqual([]);
    }
  });

  it('a `#` at the end of a heading is not escaped as a closing sequence', () => {
    expect(escapeOfmText('C\\#', '', '')).toBe('C#');
  });
});
