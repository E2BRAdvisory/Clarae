import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
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

export function initI18n(language?: string): typeof i18next {
  const lng: Language = isLanguage(language) ? language : detectLanguage();
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources: { en: { translation: en }, it: { translation: it } },
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
