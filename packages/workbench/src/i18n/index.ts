import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { withCommon } from '@memobrain/ui/i18n';
import en from './en.json';
import it from './it.json';

export const supportedLanguages = ['en', 'it'] as const;
export type Language = (typeof supportedLanguages)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (supportedLanguages as readonly string[]).includes(value);
}

export function detectLanguage(): Language {
  const nav = typeof navigator === 'undefined' ? 'en' : navigator.language.toLowerCase();
  return nav.startsWith('it') ? 'it' : 'en';
}

/** Keeps <html lang> in step with the UI language (screen readers pick the voice from it). */
function syncHtmlLang(lng: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
}

export function initI18n(language?: string): typeof i18next {
  const lng: Language = isLanguage(language) ? language : detectLanguage();
  syncHtmlLang(lng);
  i18next.off('languageChanged', syncHtmlLang);
  i18next.on('languageChanged', syncHtmlLang);
  if (!i18next.isInitialized) {
    // The strings shared with the other UI (OK, Cancel, errors.<code>…) come from @memobrain/ui.
    const { resources, options } = withCommon({ en, it });
    void i18next.use(initReactI18next).init({
      resources,
      ...options,
      lng,
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  } else if (i18next.language !== lng) {
    void i18next.changeLanguage(lng);
  }
  return i18next;
}

export { i18next };
