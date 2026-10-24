import { describe, expect, it } from 'vitest';
import { checkPassphrase, sameRecoveryKey } from './strength';

describe('passphrase policy', () => {
  it('rejects short and guessable passphrases', async () => {
    expect((await checkPassphrase('')).ok).toBe(false);
    expect(await checkPassphrase('short')).toMatchObject({ longEnough: false, ok: false });
    expect((await checkPassphrase('passwordpassword')).ok).toBe(false);
    expect((await checkPassphrase('123456789012')).ok).toBe(false);
  });

  it('accepts a long random-looking passphrase', async () => {
    const r = await checkPassphrase('correct horse battery staple orbit');
    expect(r.longEnough).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.ok).toBe(true);
  });
});

describe('sameRecoveryKey', () => {
  it('ignores case, spaces and dashes but not content', () => {
    expect(sameRecoveryKey('abcde-fghij', 'ABCDE-FGHIJ')).toBe(true);
    expect(sameRecoveryKey('ABCDE FGHIJ', 'ABCDE-FGHIJ')).toBe(true);
    expect(sameRecoveryKey('ABCDE-FGHIK', 'ABCDE-FGHIJ')).toBe(false);
    expect(sameRecoveryKey('', '')).toBe(false);
  });
});
