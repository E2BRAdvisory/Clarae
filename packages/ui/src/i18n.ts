// Strings shared by the console and the workbench (ADR-0043): OK, Cancel, Close, Retry and the
// messages of the API error codes (`errors.<code>`, RFC 9457). Each host adds them to its own i18next
// instance as the `common` namespace and makes it the fallback namespace, so its components keep
// calling `t('common.cancel')` / `t('errors.FORBIDDEN')` and a key the host defines itself wins.
import en from './i18n/en.json';
import it from './i18n/it.json';

export const COMMON_NS = 'common';

export const commonResources = { en, it } as const;

type Lang = keyof typeof commonResources;

/**
 * The i18next `resources` of a host with the common namespace added, plus the init options that make
 * it the fallback: `i18next.init({ resources, ...options, lng, … })`.
 */
export function withCommon<R extends Record<string, unknown>>(
  host: Record<Lang, R>,
): {
  resources: Record<Lang, { translation: R; common: typeof en }>;
  options: { ns: string[]; defaultNS: 'translation'; fallbackNS: string };
} {
  return {
    resources: {
      en: { translation: host.en, common: commonResources.en },
      it: { translation: host.it, common: commonResources.it },
    },
    options: { ns: ['translation', COMMON_NS], defaultNS: 'translation', fallbackNS: COMMON_NS },
  };
}
