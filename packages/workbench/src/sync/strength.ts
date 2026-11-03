// Passphrase strength (zxcvbn, §3.8.2: score >= 3 and at least 12 characters), for the live feedback
// of the dialogs and of the web page's unlock gate. The core enforces the same rule on every binding
// that sets a new passphrase (apps/desktop/internal/crypto/policy.go) and answers
// "weak-passphrase: <reason>: …", which errorMessage translates; the cases both sides must agree on
// are in shared/conformance/passphrase/policy.json. Both judge the NFC form, what the key derivation
// uses. The estimator and its dictionaries are large: they load on first use.
export const MIN_PASSPHRASE_LENGTH = 12;
export const MIN_SCORE = 3;
/** The estimate reads the first 64 code points, like the core (its matching is quadratic). */
export const MAX_ESTIMATED_LENGTH = 64;

let ready: Promise<(p: string) => number> | null = null;

async function load(): Promise<(p: string) => number> {
  const [{ ZxcvbnFactory }, common, en] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
  ]);
  const estimator = new ZxcvbnFactory({
    translations: en.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...en.dictionary },
  });
  return (p) => estimator.check(p).score;
}

/** 0 (guessable) … 4 (very strong). */
export async function passphraseScore(passphrase: string): Promise<number> {
  if (passphrase === '') return 0;
  ready ??= load();
  const prefix = [...passphrase.normalize('NFC')].slice(0, MAX_ESTIMATED_LENGTH).join('');
  return (await ready)(prefix);
}

/** Why the policy refuses a passphrase: the reasons of the core's `weak-passphrase` error. */
export type WeakReason = 'too-short' | 'guessable';

export interface PassphraseCheck {
  score: number;
  longEnough: boolean;
  ok: boolean;
  /** Set when `ok` is false. */
  reason?: WeakReason;
}

export async function checkPassphrase(passphrase: string): Promise<PassphraseCheck> {
  const longEnough = [...passphrase.normalize('NFC')].length >= MIN_PASSPHRASE_LENGTH;
  const score = await passphraseScore(passphrase);
  if (longEnough && score >= MIN_SCORE) return { score, longEnough, ok: true };
  return { score, longEnough, ok: false, reason: longEnough ? 'guessable' : 'too-short' };
}

/** Compares a typed recovery key with the real one, ignoring case, spaces and dashes. */
export const sameRecoveryKey = (typed: string, key: string): boolean =>
  normalizeKey(typed) !== '' && normalizeKey(typed) === normalizeKey(key);

const normalizeKey = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();
