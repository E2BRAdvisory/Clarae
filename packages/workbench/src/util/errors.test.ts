import { beforeAll, describe, expect, it } from 'vitest';
import { i18next, initI18n } from '../i18n';
import { errorCodeOf, errorMessage } from './errors';

beforeAll(() => {
  initI18n('en');
});

describe('errorMessage', () => {
  it('reads the code of binding errors and cloud problems', () => {
    expect(errorCodeOf(new Error('conflict: file changed on disk'))).toBe('conflict');
    expect(errorCodeOf(new Error('QUOTA_EXCEEDED: quota full'))).toBe('QUOTA_EXCEEDED');
    expect(errorCodeOf(new Error('FORBIDDEN (403)'))).toBe('FORBIDDEN');
    expect(errorCodeOf(new Error('something went wrong'))).toBe('');
  });

  it('translates a known code instead of the raw backend text', async () => {
    expect(errorMessage(new Error('exists: destination already exists'))).toBe(
      'An item with that name already exists.',
    );
    await i18next.changeLanguage('it');
    expect(errorMessage(new Error('conflict: file changed on disk'))).toMatch(/cambiato su disco/);
    await i18next.changeLanguage('en');
  });

  it('keeps an unknown error as written', () => {
    expect(errorMessage(new Error('sync: cursor lost'))).toBe('sync: cursor lost');
    expect(errorMessage('plain')).toBe('plain');
  });
});
