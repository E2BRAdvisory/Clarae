import { describe, expect, it } from 'vitest';
import { checkUsage, comparePair, flatten, overlap, withShared } from '@clarae/ui/i18nCheck';
import { commonResources } from '@clarae/ui/i18n';
import { i18next, initI18n } from './index';
import en from './en.json';
import it_ from './it.json';

const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Keys assembled at runtime that a static scan cannot see (commands.<id> and editor.mode_<mode>
// are also picked up automatically from their template literals; they are listed for clarity).
// errors.<code> are the stable codes of backend errors (util/errors.ts).
const DYNAMIC: string[] = ['commands.*', 'editor.mode_*', 'errors.*'];

describe('desktop i18n resources', () => {
  const f = comparePair(en, it_);
  it('have identical key sets', () => {
    expect(f.missingInIt).toEqual([]);
    expect(f.missingInEn).toEqual([]);
  });
  it('have no empty values', () => expect(f.empty).toEqual([]));
  it('use the same interpolation placeholders in both languages', () =>
    expect(f.placeholderMismatch).toEqual([]));
  it('have the same plural forms, with one/other (and optionally many) in Italian', () => {
    expect(f.pluralMismatch).toEqual([]);
    expect(f.italianPluralIncomplete).toEqual([]);
  });
  it('leave the shared strings (common namespace of @clarae/ui) to the package', () => {
    expect(overlap(en, commonResources.en)).toEqual([]);
    expect(overlap(it_, commonResources.it)).toEqual([]);
  });
  it('use every key and only keys that exist', () => {
    const shared = [...flatten(commonResources.en).keys()];
    const u = checkUsage(withShared(en, commonResources.en), sources, {
      allow: [...DYNAMIC, ...shared],
    });
    expect(u.missing).toEqual([]);
    expect(u.unused).toEqual([]);
  });
});

describe('shared strings', () => {
  it('resolve through the common namespace, the host keys first', async () => {
    initI18n('it');
    await i18next.changeLanguage('it');
    expect(i18next.t('common.cancel')).toBe('Annulla');
    expect(i18next.exists('errors.FORBIDDEN')).toBe(true);
    expect(i18next.t('errors.FORBIDDEN')).toBe(commonResources.it.errors.FORBIDDEN);
    expect(i18next.t('errors.conflict')).toBe(it_.errors.conflict);
    expect(i18next.exists('errors.NO_SUCH_CODE')).toBe(false);
    await i18next.changeLanguage('en');
    expect(i18next.t('common.ok')).toBe('OK');
  });
});
