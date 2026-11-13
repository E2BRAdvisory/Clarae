import { describe, expect, it } from 'vitest';
import { checkUsage, comparePair, flatten, overlap, withShared } from '@clarae/ui/i18nCheck';
import { commonResources } from '@clarae/ui/i18n';
import en from './en.json';
import it_ from './it.json';

const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});
// packages/ui components also call t() with keys that live in this app's resources.
const uiSources = import.meta.glob<string>('../../../packages/ui/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Keys assembled at runtime that a static scan cannot see.
const DYNAMIC: string[] = [];

describe('web i18n resources', () => {
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
    // Shared strings may be used or not by this host; errors.<code> are looked up by code.
    const shared = [...flatten(commonResources.en).keys()];
    const u = checkUsage(
      withShared(en, commonResources.en),
      { ...sources, ...uiSources },
      {
        allow: [...DYNAMIC, ...shared],
      },
    );
    expect(u.missing).toEqual([]);
    expect(u.unused).toEqual([]);
  });
});
