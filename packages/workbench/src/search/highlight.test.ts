import { describe, expect, it } from 'vitest';
import { snippetParts } from './highlight';

describe('snippetParts', () => {
  it('marks the reported ranges', () => {
    expect(
      snippetParts('Il caffè è pronto, il caffè no', [
        [3, 8],
        [22, 27],
      ]),
    ).toEqual([
      { text: 'Il ', mark: false },
      { text: 'caffè', mark: true },
      { text: ' è pronto, il ', mark: false },
      { text: 'caffè', mark: true },
      { text: ' no', mark: false },
    ]);
  });

  it('uses UTF-16 offsets, as the backend sends them', () => {
    expect(snippetParts('😀 café', [[3, 7]])).toEqual([
      { text: '😀 ', mark: false },
      { text: 'café', mark: true },
    ]);
  });

  it('keeps the plain text when the ranges are missing or malformed', () => {
    expect(snippetParts('plain')).toEqual([{ text: 'plain', mark: false }]);
    expect(
      snippetParts('short', [
        [2, 99],
        [1, 3],
        [40, 50],
      ]),
    ).toEqual([
      { text: 'sh', mark: false },
      { text: 'ort', mark: true },
    ]);
  });
});
