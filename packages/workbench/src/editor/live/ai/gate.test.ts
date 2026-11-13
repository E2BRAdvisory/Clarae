import { Feature, FEATURE_DEFAULTS, featureEnabled } from '@clarae/api-client/features';
import { describe, expect, it } from 'vitest';
import { checkAi, type AiGateDeps } from './gate';
import { fakeCore, openStatus } from './testing';

const OPEN = (core = fakeCore()): AiGateDeps => ({
  build: () => true,
  features: () => ({ [Feature.Ai]: true }),
  capable: () => true,
  privateVault: () => false,
  port: core,
});

describe('the flags are declared and off', () => {
  // A flag the schema does not know is on: `ai` and `collab` must stay declared, with default false
  // (api/config-profile.schema.json; ADR-0050).
  it('ai and collab are off without a profile', () => {
    expect(FEATURE_DEFAULTS[Feature.Ai]).toBe(false);
    expect(FEATURE_DEFAULTS[Feature.Collab]).toBe(false);
    expect(featureEnabled({}, Feature.Ai)).toBe(false);
    expect(featureEnabled(undefined, Feature.Collab)).toBe(false);
    expect(featureEnabled({ [Feature.Ai]: true }, Feature.Ai)).toBe(true);
  });
});

describe('when the assistant may be offered', () => {
  it('is open only when every gate is', async () => {
    const core = fakeCore({ status: openStatus({ provider: 'anthropic' }) });
    const gate = await checkAi('v1', OPEN(core));
    expect(gate).toMatchObject({ open: true, status: { provider: 'anthropic' } });
    expect(core.statusCalls).toEqual(['v1']);
  });

  const closed: [string, Partial<AiGateDeps>, string][] = [
    ['the build constant is off', { build: () => false }, 'build'],
    ['the flag is off', { features: () => ({ [Feature.Ai]: false }) }, 'flag'],
    ['the profile does not mention it', { features: () => ({}) }, 'flag'],
    ['the host has no capability', { capable: () => false }, 'capability'],
    ['the vault is private', { privateVault: () => true }, 'private-vault'],
  ];
  for (const [name, over, why] of closed) {
    it(`is closed when ${name}, and the core is not even asked`, async () => {
      const core = fakeCore();
      const gate = await checkAi('v1', { ...OPEN(core), ...over });
      expect(gate).toEqual({ open: false, closed: why });
      expect(core.statusCalls).toEqual([]);
    });
  }

  it('is closed when the core says it is not available, or cannot say', async () => {
    const off = fakeCore({
      status: openStatus({ available: false, reason: 'not-configured', configured: false }),
    });
    expect(await checkAi('v', OPEN(off))).toEqual({ open: false, closed: 'unavailable' });
    const broken = fakeCore({ status: new Error('ai-disabled: not available in the browser') });
    expect(await checkAi('v', OPEN(broken))).toEqual({ open: false, closed: 'unavailable' });
  });
});
