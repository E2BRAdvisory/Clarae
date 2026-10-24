import { describe, expect, it } from 'vitest';
import { loadMarkdownCases } from './index';

describe('conformance fixtures', () => {
  it('are well formed and non-empty', () => {
    const cases = loadMarkdownCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.expected.title).toBe(c.name);
    }
  });
});
