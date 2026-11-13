import { describe, expect, it } from 'vitest';
import { loadMarkdownCases } from '@clarae/conformance';
import { extract, parseProperties, splitFrontmatter } from './extract';

// Every shared fixture must produce exactly the expectation that the Go parser
// also satisfies (apps/desktop/internal/parser). Offsets are not part of the contract.
function shape(d: ReturnType<typeof extract>) {
  return {
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
  };
}

describe('conformance with the Go parser', () => {
  for (const c of loadMarkdownCases()) {
    it(c.name, () => {
      expect(shape(extract(c.name, c.source))).toEqual(c.expected);
    });
  }
});

// The index reads a CRLF file as an LF one (apps/desktop/internal/parser, TestConformanceCRLF): the
// CR is a line ending, not text. A setext heading over several lines keeps the CRLF inside its text.
describe('conformance with the Go parser, CRLF line endings', () => {
  for (const c of loadMarkdownCases()) {
    if (c.source.includes('\r') || c.expected.headings.some((h) => h.text.includes('\n'))) continue;
    it(c.name, () => {
      expect(shape(extract(c.name, c.source.replace(/\n/g, '\r\n')))).toEqual(c.expected);
    });
  }
});

// A leading BOM is not content (apps/desktop/internal/parser, TestParseSkipsLeadingBOM): it hides
// neither the frontmatter nor an ATX heading on the first line. Offsets point into the string as it is.
describe('a leading BOM', () => {
  const lf = '---\ntags: [t]\n---\n# H #\nSee [[a|b]] and [t](x.md)\n';
  for (const src of [lf, '# H #\nSee [[a|b]] and [t](x.md)\n']) {
    it(`reads ${JSON.stringify(src.slice(0, 8))} like the same text without it`, () => {
      const plain = extract('n', src);
      const withBom = extract('n', '\uFEFF' + src);
      expect(withBom.headings).toEqual(plain.headings);
      expect(withBom.headings[0]?.text).toBe('H');
      expect({ ...withBom, links: [] }).toEqual({ ...plain, links: [] });
      expect(withBom.links.map((l) => ('\uFEFF' + src).slice(l.start, l.end))).toEqual(
        plain.links.map((l) => src.slice(l.start, l.end)),
      );
      expect(withBom.links.map((l) => l.start)).toEqual(plain.links.map((l) => l.start + 1));
    });
  }

  it('splits the frontmatter and does not keep the BOM in the body', () => {
    const fm = splitFrontmatter('\uFEFF---\ntitle: x\n---\n# Body\n');
    expect(fm).toEqual({ body: '# Body\n', lines: 3, yaml: 'title: x\n' });
    expect(splitFrontmatter('\uFEFFplain').body).toBe('plain');
    expect(parseProperties('\uFEFF---\nk: v\n---\n')).toEqual({ k: 'v' });
  });
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
