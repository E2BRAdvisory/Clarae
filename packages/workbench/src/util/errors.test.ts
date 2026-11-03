import { beforeAll, describe, expect, it } from 'vitest';
import { i18next, initI18n } from '../i18n';
import en from '../i18n/en.json';
import { errorCodeOf, errorMessage } from './errors';

// The Go sources that declare the codes of the binding errors (ErrCodeX = "x").
const goSources = import.meta.glob<string>(
  ['../../../../apps/desktop/internal/app/*.go', '!**/*_test.go'],
  { query: '?raw', import: 'default', eager: true },
);

// The passphrase policy of the core (its reasons, WeakX = "…").
const cryptoPolicy = Object.values(
  import.meta.glob<string>('../../../../apps/desktop/internal/crypto/policy.go', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0];

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

  it('translate a weak passphrase by its reason (the policy is enforced in the core)', async () => {
    const short = new Error(
      'weak-passphrase: too-short: the passphrase must have at least 12 characters',
    );
    const guessable = new Error(
      'weak-passphrase: guessable: the passphrase is too easy to guess: add words or make it longer',
    );
    expect(errorCodeOf(short)).toBe('weak-passphrase');
    expect(errorMessage(short)).toBe('The passphrase needs at least 12 characters.');
    expect(errorMessage(guessable)).toBe(
      'This passphrase is too easy to guess: add words or make it longer.',
    );
    // A reason this version does not know: the generic sentence, with the core's text.
    expect(errorMessage(new Error('weak-passphrase: reused: seen in a breach'))).toBe(
      'The passphrase is too weak: reused: seen in a breach',
    );
    await i18next.changeLanguage('it');
    expect(errorMessage(short)).toBe('La passphrase deve avere almeno 12 caratteri.');
    expect(errorMessage(guessable)).toMatch(/troppo facile da indovinare/);
    await i18next.changeLanguage('en');
    // The reasons the core declares (crypto.WeakX = "…") each have a sentence.
    const reasons = [...(cryptoPolicy ?? '').matchAll(/\bWeak\w+\s*=\s*"([^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(reasons.filter((r) => !(`weak-passphrase_${r}` in en.errors))).toEqual([]);
  });

  it('translate a wrong passphrase or recovery key by its code', async () => {
    expect(errorMessage(new Error('wrong-secret: wrong passphrase or recovery key'))).toBe(
      'Wrong passphrase or recovery key.',
    );
    await i18next.changeLanguage('it');
    expect(errorMessage('wrong-secret: wrong passphrase or recovery key')).toBe(
      'Passphrase o chiave di recupero errata.',
    );
    await i18next.changeLanguage('en');
    // Without the code the text is only text: it stays as written.
    expect(errorMessage('wrong passphrase or recovery key')).toBe(
      'wrong passphrase or recovery key',
    );
  });
});
