import type { TFunction } from 'i18next';
import { ApiError } from '@memobrain/api-client';

/** User-facing text for an error: a translated message per RFC 9457 code when known. */
export function describeError(err: unknown, t: TFunction): string {
  if (err instanceof ApiError) {
    const key = `errors.${err.code}`;
    const known = t(key, { defaultValue: '' });
    if (known) return known;
    return err.message
      ? t('common.errorWithCode', { message: err.message, code: err.code })
      : t('common.errorGeneric');
  }
  return t('common.errorGeneric');
}
