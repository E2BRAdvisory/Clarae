import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectLanguage, initI18n, setLanguage } from './index';
import { renderApp } from '../test/utils';

afterEach(async () => {
  window.localStorage.clear();
  await setLanguage('en');
  vi.restoreAllMocks();
});

describe('i18n', () => {
  it('defaults to the browser language and falls back to English', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('it-IT');
    expect(detectLanguage()).toBe('it');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
    expect(detectLanguage()).toBe('en');
  });

  it('prefers the saved choice', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('it-IT');
    window.localStorage.setItem('memobrain.web.lang', 'en');
    expect(detectLanguage()).toBe('en');
    expect(initI18n().language).toBe('en');
  });

  it('switches the UI language from the header and remembers it', async () => {
    renderApp({
      path: '/usage',
      routes: { 'GET /me/usage': { used_bytes: 1, quota_bytes: 100, level: 'ok' } },
    });
    expect(await screen.findByRole('heading', { name: 'Storage used' })).toBeInTheDocument();
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'it');
    expect(await screen.findByRole('heading', { name: 'Spazio utilizzato' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'I miei vault' })).toBeInTheDocument();
    expect(window.localStorage.getItem('memobrain.web.lang')).toBe('it');
    expect(document.documentElement.lang).toBe('it');
  });

  it('has the same keys in both languages', async () => {
    const en = (await import('./en.json')).default as Record<string, unknown>;
    const it = (await import('./it.json')).default as Record<string, unknown>;
    const flat = (o: Record<string, unknown>, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null
          ? flat(v as Record<string, unknown>, `${p}${k}.`)
          : [`${p}${k}`],
      );
    expect(flat(it).sort()).toEqual(flat(en).sort());
  });
});
