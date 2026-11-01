import { describe, expect, it } from 'vitest';
import { safeDecodeURI } from './uri';

describe('safeDecodeURI', () => {
  it('decodes well-formed escapes', () => {
    expect(safeDecodeURI('My%20Note.md')).toBe('My Note.md');
  });

  it('keeps a malformed escape as written instead of throwing', () => {
    expect(safeDecodeURI('100%.png')).toBe('100%.png');
    expect(safeDecodeURI('growth%2050%.png')).toBe('growth%2050%.png');
  });
});
