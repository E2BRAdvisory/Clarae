import { describe, expect, it } from 'vitest';
import { embedOptions } from './media';

describe('embedOptions', () => {
  it('reads size and alignment from an alias, in any order', () => {
    expect(embedOptions('300')).toEqual({ size: { width: 300 } });
    expect(embedOptions('300x200')).toEqual({ size: { width: 300, height: 200 } });
    expect(embedOptions('300|left')).toEqual({ size: { width: 300 }, align: 'left' });
    expect(embedOptions('right-wrap|120x80')).toEqual({
      size: { width: 120, height: 80 },
      align: 'right-wrap',
    });
    expect(embedOptions('Center')).toEqual({ size: {}, align: 'center' });
  });

  it('ignores anything else (a plain alias, empty text)', () => {
    expect(embedOptions('')).toEqual({ size: {} });
    expect(embedOptions('a caption')).toEqual({ size: {} });
    expect(embedOptions('middle|big')).toEqual({ size: {} });
  });
});
