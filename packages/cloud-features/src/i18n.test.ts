import { describe, expect, it } from 'vitest';
import { checkUsage, comparePair } from '@memobrain/ui/i18nCheck';
import { createT, langOf, resources } from './i18n';
import { errorCode } from './port';

const sources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.*', '!./testing/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('strings', () => {
  it('English and Italian have the same keys, placeholders and plurals', () => {
    const f = comparePair(resources.en, resources.it);
    expect(f).toEqual({
      missingInIt: [],
      missingInEn: [],
      empty: [],
      placeholderMismatch: [],
      pluralMismatch: [],
      italianPluralIncomplete: [],
    });
  });

  it('every string is used and every used key exists', () => {
    const { missing, unused } = checkUsage(resources.en, sources);
    expect({ missing, unused }).toEqual({ missing: [], unused: [] });
  });

  it('interpolates and picks plural forms', () => {
    const t = createT('it-IT');
    expect(t('vaults.renamed', { name: 'Diario' })).toBe('«Diario» rinominato.');
    expect(t('delete.retentionDays', { count: 1 })).toContain('per 1 giorno');
    expect(createT('en')('delete.retentionDays', { count: 30 })).toContain('for 30 days');
    expect(langOf('fr')).toBe('en');
  });
});

describe('errorCode', () => {
  it('reads the code of either adapter', () => {
    expect(errorCode({ code: 'NAME_IN_USE' })).toBe('NAME_IN_USE');
    expect(errorCode(new Error('NAME_IN_USE: a vault with this name exists'))).toBe('NAME_IN_USE');
    expect(errorCode(new Error('name-in-use: you already have a vault'))).toBe('NAME_IN_USE');
    expect(errorCode(new Error('not signed in to the cloud'))).toBe('UNKNOWN');
  });
});
