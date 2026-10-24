import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import it from './it.json';

export const supportedLanguages = ['en', 'it'] as const;
export type Language = (typeof supportedLanguages)[number];

const STORAGE_KEY = 'nodus.web.lang';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (supportedLanguages as readonly string[]).includes(value);
}

/** Saved choice first, then the browser language (Italian or English). */
export function detectLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    /* storage unavailable: fall through */
  }
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

/** Switches the UI language and remembers the choice. */
export async function setLanguage(lng: Language): Promise<void> {
  try {
    window.localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lng;
  await i18next.changeLanguage(lng);
}

export { i18next };
