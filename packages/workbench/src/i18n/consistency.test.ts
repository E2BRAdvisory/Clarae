import { describe, expect, it } from 'vitest';
import { checkUsage, comparePair } from '../../../ui/src/i18nCheck';
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
  it('use every key and only keys that exist', () => {
    const u = checkUsage(en, sources, { allow: DYNAMIC });
    expect(u.missing).toEqual([]);
    expect(u.unused).toEqual([]);
  });
});
