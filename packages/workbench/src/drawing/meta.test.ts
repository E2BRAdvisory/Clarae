import { describe, expect, it } from 'vitest';
import {
  elementMeta,
  fileSettingsOf,
  LEGACY_META_KEYS,
  META_KEY,
  normalizeFileExtra,
  withElementMeta,
  withFileSetting,
} from './meta';

// The legacy key as 1.x wrote it. The names are pinned so a rename cannot change them by accident.
const OLD = 'memobrain';

describe('meta keys', () => {
  it('writes the new key and reads the one of 1.x', () => {
    expect(META_KEY).toBe('clarae');
    expect([...LEGACY_META_KEYS]).toEqual([OLD]);
  });
});

describe('elementMeta', () => {
  it('reads the new key', () => {
    expect(elementMeta({ customData: { clarae: { kind: 'note' } } })).toEqual({ kind: 'note' });
  });
  it('reads an element of a 1.x file', () => {
    expect(elementMeta({ customData: { [OLD]: { kind: 'latex', latex: 'x' } } })).toEqual({
      kind: 'latex',
      latex: 'x',
    });
  });
  it('prefers the new key when an element has both', () => {
    const e = { customData: { [OLD]: { notes: 'old' }, clarae: { notes: 'new' } } };
    expect(elementMeta(e)).toEqual({ notes: 'new' });
  });
  it('is undefined without metadata', () => {
    expect(elementMeta(undefined)).toBeUndefined();
    expect(elementMeta({})).toBeUndefined();
    expect(elementMeta({ customData: { other: 1 } })).toBeUndefined();
    expect(elementMeta({ customData: 'x' })).toBeUndefined();
  });
});

describe('withElementMeta', () => {
  it('migrates on rewrite: new key in, legacy key out, the rest kept', () => {
    const cd = { other: 1, [OLD]: { kind: 'note', path: 'a.md' } };
    expect(withElementMeta(cd, { kind: 'note', path: 'b.md' })).toEqual({
      other: 1,
      clarae: { kind: 'note', path: 'b.md' },
    });
    expect(cd).toEqual({ other: 1, [OLD]: { kind: 'note', path: 'a.md' } }); // input untouched
  });
  it('drops a legacy key that sits next to the new one', () => {
    const out = withElementMeta({ [OLD]: { a: 1 }, clarae: { a: 2 } }, { a: 3 });
    expect(out).toEqual({ clarae: { a: 3 } });
  });
  it('starts from nothing', () => {
    expect(withElementMeta(undefined, { kind: 'image' })).toEqual({ clarae: { kind: 'image' } });
  });
});

describe('file settings', () => {
  it('reads the legacy key', () => {
    expect(fileSettingsOf({ [OLD]: { autoExport: 'png' } })).toEqual({ autoExport: 'png' });
  });
  it('merges both keys, the new one winning', () => {
    const extra = {
      [OLD]: { autoExport: 'png', slideLoop: 'true' },
      clarae: { autoExport: 'svg' },
    };
    expect(fileSettingsOf(extra)).toEqual({ autoExport: 'svg', slideLoop: 'true' });
  });
  it('is empty without settings', () => {
    expect(fileSettingsOf({ other: 1 })).toEqual({});
  });

  it('normalizes: merged under the new key, legacy omitted, others kept', () => {
    const extra = { other: 1, [OLD]: { a: 1, b: 1 }, clarae: { b: 2 } };
    expect(normalizeFileExtra(extra)).toEqual({ other: 1, clarae: { a: 1, b: 2 } });
    expect(normalizeFileExtra(normalizeFileExtra(extra))).toEqual({
      other: 1,
      clarae: { a: 1, b: 2 },
    });
  });
  it('leaves no key for empty settings', () => {
    expect(normalizeFileExtra({ [OLD]: {}, other: 1 })).toEqual({ other: 1 });
  });

  it('sets a setting on a 1.x file: the value is written under the new key only', () => {
    const out = withFileSetting({ [OLD]: { slideLoop: 'true' } }, 'autoExport', 'png');
    expect(out).toEqual({ clarae: { slideLoop: 'true', autoExport: 'png' } });
  });
  it('clears a setting that only the legacy key had, and the key with it', () => {
    expect(withFileSetting({ [OLD]: { autoExport: 'png' } }, 'autoExport', null)).toEqual({});
  });
});
