import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT, applyAppearance, customAccent, defaultAppearance } from './settings';

const root = document.documentElement;
afterEach(() => root.removeAttribute('style'));

describe('accent', () => {
  it('treats the defaults, old and new, as no accent of the user', () => {
    expect(customAccent(DEFAULT_ACCENT)).toBeNull();
    expect(customAccent('#6C5CE7')).toBeNull(); // the default of 1.x, still stored in vaults
    expect(customAccent('not a colour')).toBeNull();
    expect(customAccent('#ff8800')).toBe('#ff8800');
  });

  it('leaves the accent to the theme tokens with a default', () => {
    applyAppearance({ ...defaultAppearance, accent: '#ff8800' });
    applyAppearance({ ...defaultAppearance, accent: '#6c5ce7' });
    for (const name of ['--accent', '--accent-bright', '--accent-contrast']) {
      expect(root.style.getPropertyValue(name)).toBe('');
    }
  });

  it("applies the user's colour to every role of the accent, with white on it", () => {
    applyAppearance({ ...defaultAppearance, accent: '#ff8800' });
    expect(root.style.getPropertyValue('--accent')).toBe('#ff8800');
    expect(root.style.getPropertyValue('--accent-bright')).toBe('#ff8800');
    expect(root.style.getPropertyValue('--accent-contrast')).toBe('#ffffff');
  });
});
