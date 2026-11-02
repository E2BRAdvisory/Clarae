import { beforeAll, describe, expect, it } from 'vitest';
import { i18next, initI18n } from '../i18n';
import en from '../i18n/en.json';
import { errorCodeOf, errorMessage } from './errors';

// The Go sources that declare the codes of the binding errors (ErrCodeX = "x").
const goSources = import.meta.glob<string>(
  ['../../../../apps/desktop/internal/app/*.go', '!**/*_test.go'],
  { query: '?raw', import: 'default', eager: true },
);

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

describe('codes of the desktop bindings', () => {
  it('each have a translation', () => {
    // apps/desktop/internal/app: errors.go, bindings_auth.go, …
    const codes = new Set<string>();
    for (const src of Object.values(goSources))
      for (const m of src.matchAll(/\bErrCode\w+\s*=\s*"([^"]+)"/g)) codes.add(m[1] as string);
    expect(codes.size).toBeGreaterThanOrEqual(10);
    const missing = [...codes].filter((c) => !(c in en.errors));
    expect(missing).toEqual([]);
  });

  it('are translated, with the failed operation when it helps', async () => {
    expect(errorMessage(new Error('io: open: no space left on device'))).toBe(
      'The file could not be read or written (open: no space left on device).',
    );
    expect(errorMessage(new Error('insecure-url: insecure url: use https'))).toMatch(
      /^Sign-in refused/,
    );
    await i18next.changeLanguage('it');
    expect(errorMessage(new Error('permission: access denied by the operating system'))).toBe(
      'Il sistema operativo ha negato l’accesso al file.',
    );
    expect(errorMessage(new Error('internal: local index error; see the log'))).toMatch(
      /errore interno/,
    );
    await i18next.changeLanguage('en');
  });

  it('translate the known messages of the core that have no code', async () => {
    expect(errorMessage(new Error('wrong passphrase or recovery key'))).toBe(
      'Wrong passphrase or recovery key.',
    );
    await i18next.changeLanguage('it');
    expect(errorMessage('wrong passphrase or recovery key')).toBe(
      'Passphrase o chiave di recupero errata.',
    );
    await i18next.changeLanguage('en');
    // Only the whole message: a longer one stays as written.
    expect(errorMessage('unlock: wrong passphrase or recovery key x')).toBe(
      'unlock: wrong passphrase or recovery key x',
    );
  });
});
