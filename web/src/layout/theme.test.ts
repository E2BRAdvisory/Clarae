import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, loadTheme } from './theme';
import { LEGACY_THEME_KEY } from '../workbench/legacyNames';

// 1.x kept the choice under another key: it counts until this release stores one of its own.
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('console theme', () => {
  it('is automatic without a choice', () => {
    expect(loadTheme()).toBe('auto');
  });

  it('keeps the choice made with 1.x, and writes the new key when applied', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'dark');
    expect(loadTheme()).toBe('dark');
    applyTheme(loadTheme());
    expect(localStorage.getItem('clarae.web.theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(LEGACY_THEME_KEY)).toBe('dark'); // not deleted in this release
  });

  it('lets the new key win, and "auto" really go back to the system theme', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'dark');
    applyTheme('light');
    expect(loadTheme()).toBe('light');
    applyTheme('auto');
    // the old choice must not come back from behind
    expect(loadTheme()).toBe('auto');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
