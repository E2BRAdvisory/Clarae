import i18next from 'i18next';

/** "it" or "en": the language of month and weekday names in templates. */
export function uiLang(): string {
  return (i18next.language || 'en').slice(0, 2).toLowerCase() === 'it' ? 'it' : 'en';
}
