import { describe, expect, it } from 'vitest';
import { loadMarkdownCases } from '@nodus/conformance';
import { extract } from './extract';

// Every shared fixture must produce exactly the expectation that the Go parser
// also satisfies (apps/desktop/internal/parser). Offsets are not part of the contract.
describe('conformance with the Go parser', () => {
  for (const c of loadMarkdownCases()) {
    it(c.name, () => {
      const d = extract(c.name, c.source);
      expect({
        title: d.title,
        aliases: d.aliases,
        properties: d.properties,
        headings: d.headings,
        links: d.links.map(({ line, kind, target, heading, block, alias, embed }) => ({
          line,
          kind,
          target,
          heading,
          block,
          alias,
          embed,
        })),
        tags: d.tags,
        blockIds: d.blockIds,
        tasks: d.tasks,
        footnotes: d.footnotes,
        wordCount: d.wordCount,
      }).toEqual(c.expected);
    });
  }
});

describe('offsets', () => {
  it('locate link tokens and targets in the source', () => {
    const src =
      '---\na: 1\n---\nCafé `[[x]]` [[ Nota |alias]] e ![[img.png#p|3]] [t](a%20b.md#h)\n';
    const links = extract('n', src).links;
    expect(links.map((l) => src.slice(l.start, l.end))).toEqual([
      '[[ Nota |alias]]',
      '![[img.png#p|3]]',
      '[t](a%20b.md#h)',
    ]);
    expect(links.map((l) => src.slice(l.targetStart, l.targetEnd))).toEqual([
      'Nota',
      'img.png',
      'a%20b.md',
    ]);
  });
});
