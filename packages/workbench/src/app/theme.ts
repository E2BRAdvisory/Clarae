export type Theme = 'system' | 'light' | 'dark';

/** Applies the theme as a data attribute consumed by styles/tokens.css. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

/** Resolves "system" to the effective theme. */
export function effectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The theme in force now: the `data-theme` of the page, or the system's choice for "system". */
export function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.getAttribute('data-theme');
  return effectiveTheme(set === 'light' || set === 'dark' ? set : 'system');
}

/**
 * Calls `listener` whenever the theme in force may have changed: the setting (the `data-theme`
 * attribute) or, for "system", the colour scheme of the operating system — while the app is
 * open, not only at the next start. Returns the function that stops listening.
 */
export function watchTheme(listener: () => void): () => void {
  const observer =
    typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => listener());
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onScheme = (): void => listener();
  media?.addEventListener?.('change', onScheme);
  return () => {
    observer?.disconnect();
    media?.removeEventListener?.('change', onScheme);
  };
}
