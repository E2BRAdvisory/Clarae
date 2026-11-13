import { describe, expect, it } from 'vitest';
import { loadSlideCases } from '@clarae/conformance';
import { DEFAULT_SLIDE_CONFIG, parseSlideConfig, parseSlides } from './slides';

// Every shared fixture must produce exactly the expectation that the Go parser also satisfies
// (apps/desktop/internal/parser/slides_test.go).
describe('slides: conformance with the Go parser', () => {
  const cases = loadSlideCases();
  it('has fixtures', () => expect(cases.length).toBeGreaterThan(5));
  for (const c of cases) {
    it(c.name, () => expect(parseSlides(c.source)).toEqual(c.expected));
  }
});

describe('slides', () => {
  it('reads and writes nothing but the document: a BOM and CRLF do not change the result', () => {
    const lf = '# A\n\nNote: n\n\n---\n\n# B\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseSlides('\uFEFF' + crlf)).toEqual(parseSlides(lf));
  });

  it('uses the defaults for a note without configuration', () => {
    expect(parseSlideConfig('# x')).toEqual(DEFAULT_SLIDE_CONFIG);
  });
});
