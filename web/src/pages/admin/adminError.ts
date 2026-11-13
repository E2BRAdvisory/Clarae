import type { TFunction } from 'i18next';
import { ApiError } from '@clarae/api-client';
import { describeError } from '../../api/errors';

/** Like describeError, with administration-specific wording for the frequent state conflicts. */
export function adminError(err: unknown, t: TFunction): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_STATE') return t('admin.errors.invalidState');
    if (err.code === 'VALIDATION_FAILED')
      return err.message
        ? t('admin.errors.validation', { message: err.message })
        : t('admin.errors.validationPlain');
  }
  return describeError(err, t);
}
