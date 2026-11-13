export type Theme = 'auto' | 'light' | 'dark';
import { LEGACY_THEME_KEY } from '../workbench/legacyNames';

const KEY = 'clarae.web.theme';

export function loadTheme(): Theme {
  try {
    // The choice of 1.x counts until this release stores one of its own (the old key is kept).
    const v = window.localStorage.getItem(KEY) ?? window.localStorage.getItem(LEGACY_THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage unavailable */
  }
  return 'auto';
}

/** `auto` follows the OS (no attribute); light/dark force the tokens via data-theme. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    // 'auto' is stored too: removing the key would bring back the choice of 1.x behind it.
    window.localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
}
