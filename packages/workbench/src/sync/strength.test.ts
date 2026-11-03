import { describe, expect, it } from 'vitest';
import {
  MAX_ESTIMATED_LENGTH,
  MIN_PASSPHRASE_LENGTH,
  MIN_SCORE,
  checkPassphrase,
  sameRecoveryKey,
} from './strength';

interface PolicyFixture {
  minLength: number;
  minScore: number;
  maxEstimatedLength: number;
  cases: { note?: string; passphrase: string; ok: boolean; reason?: string }[];
}

// The cases the core's policy (apps/desktop/internal/crypto/policy_test.go) runs too.
const fixture = JSON.parse(
  Object.values(
    import.meta.glob<string>('../../../../shared/conformance/passphrase/policy.json', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0] ?? '{}',
) as PolicyFixture;

describe('passphrase policy: shared fixtures', () => {
  it('has the rule of the core', () => {
    expect(fixture.minLength).toBe(MIN_PASSPHRASE_LENGTH);
    expect(fixture.minScore).toBe(MIN_SCORE);
    expect(fixture.maxEstimatedLength).toBe(MAX_ESTIMATED_LENGTH);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixture.cases ?? [])('$passphrase', async (c) => {
    const r = await checkPassphrase(c.passphrase);
    expect(r.ok).toBe(c.ok);
    expect(r.reason).toBe(c.ok ? undefined : c.reason);
  });
});

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
