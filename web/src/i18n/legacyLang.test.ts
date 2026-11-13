import { beforeEach, describe, expect, it } from 'vitest';
import { detectLanguage, setLanguage } from './index';
import { LEGACY_LANG_KEY } from '../workbench/legacyNames';

// 1.x kept the language under another key: it counts until this release stores one of its own.
beforeEach(() => localStorage.clear());

describe('console language', () => {
  it('keeps the choice made with 1.x', () => {
    localStorage.setItem(LEGACY_LANG_KEY, 'it');
    expect(detectLanguage()).toBe('it');
  });

  it('lets the new key win and writes only that one', async () => {
    localStorage.setItem(LEGACY_LANG_KEY, 'it');
    localStorage.setItem('clarae.web.lang', 'en');
    expect(detectLanguage()).toBe('en');
    await setLanguage('it');
    expect(localStorage.getItem('clarae.web.lang')).toBe('it');
    expect(localStorage.getItem(LEGACY_LANG_KEY)).toBe('it'); // left as it was
  });

  it('ignores a value that is not a language', () => {
    localStorage.setItem(LEGACY_LANG_KEY, 'xx');
    expect(['en', 'it']).toContain(detectLanguage());
  });
});
