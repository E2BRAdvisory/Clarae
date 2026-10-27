import { afterEach, describe, expect, it } from 'vitest';
import { i18next, initI18n } from './index';

afterEach(async () => {
  await i18next.changeLanguage('en');
});

describe('html lang', () => {
  it('follows the UI language, so screen readers pick the right voice', async () => {
    initI18n('it');
    await i18next.changeLanguage('it');
    expect(document.documentElement.lang).toBe('it');
    await i18next.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
