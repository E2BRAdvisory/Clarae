// Passphrase strength (zxcvbn, §3.8.2: score >= 3 and at least 12 characters).
// The estimator and its dictionaries are large: they load on first use.
export const MIN_PASSPHRASE_LENGTH = 12;
export const MIN_SCORE = 3;

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
  return (await ready)(passphrase);
}

export interface PassphraseCheck {
  score: number;
  longEnough: boolean;
  ok: boolean;
}

export async function checkPassphrase(passphrase: string): Promise<PassphraseCheck> {
  const longEnough = [...passphrase].length >= MIN_PASSPHRASE_LENGTH;
  const score = await passphraseScore(passphrase);
  return { score, longEnough, ok: longEnough && score >= MIN_SCORE };
}

/** Compares a typed recovery key with the real one, ignoring case, spaces and dashes. */
export const sameRecoveryKey = (typed: string, key: string): boolean =>
  normalizeKey(typed) !== '' && normalizeKey(typed) === normalizeKey(key);

const normalizeKey = (s: string): string => s.replace(/[\s-]/g, '').toUpperCase();
