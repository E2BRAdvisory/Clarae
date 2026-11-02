import { describe, expect, it } from 'vitest';
import { COMMON_NS, commonResources, withCommon } from './i18n';
import { comparePair, overlap, withShared } from './i18nCheck';

describe('shared strings', () => {
  it('English and Italian have the same keys, placeholders and plurals', () => {
    expect(comparePair(commonResources.en, commonResources.it)).toEqual({
      missingInIt: [],
      missingInEn: [],
      empty: [],
      placeholderMismatch: [],
      pluralMismatch: [],
      italianPluralIncomplete: [],
    });
  });

  it('are added to a host as the fallback namespace', () => {
    const { resources, options } = withCommon({ en: { a: 'A' }, it: { a: 'A' } });
    expect(resources.it.common.common.cancel).toBe('Annulla');
    expect(resources.en.translation).toEqual({ a: 'A' });
    expect(options).toEqual({
      ns: ['translation', COMMON_NS],
      defaultNS: 'translation',
      fallbackNS: COMMON_NS,
    });
  });

  it('are laid over a host for the checks, and an overlap is reported', () => {
    const host = { errors: { local: 'x' }, common: { never: 'Never' } };
    const merged = withShared(host, commonResources.en) as {
      errors: Record<string, string>;
      common: Record<string, string>;
    };
    expect(merged.errors['local']).toBe('x');
    expect(merged.errors['FORBIDDEN']).toBe(commonResources.en.errors.FORBIDDEN);
    expect(merged.common['never']).toBe('Never');
    expect(merged.common['ok']).toBe('OK');
    expect(overlap(host, commonResources.en)).toEqual([]);
    expect(overlap({ common: { ok: 'Okay' } }, commonResources.en)).toEqual(['common.ok']);
  });
});
