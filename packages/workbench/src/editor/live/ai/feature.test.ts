import { Feature } from '@memobrain/api-client/features';
import { describe, expect, it, vi } from 'vitest';
import type { loadAi } from '../chunks';
import { attachAi } from './feature';
import type { AiGateDeps } from './gate';
import { fakeCore } from './testing';

const builder = () => ({ addFeature: vi.fn().mockReturnThis() });
const chunk = () => ({ ai: vi.fn() }) as unknown as Awaited<ReturnType<typeof loadAi>>;

const deps = (over: Partial<AiGateDeps> = {}): AiGateDeps => ({
  build: () => true,
  features: () => ({ [Feature.Ai]: true }),
  capable: () => true,
  privateVault: () => false,
  port: fakeCore(),
  ...over,
});

describe('attaching the assistant to the editor', () => {
  it('loads nothing and adds nothing while a gate is closed', async () => {
    const closed: Partial<AiGateDeps>[] = [
      { build: () => false },
      { features: () => ({}) },
      { features: () => ({ [Feature.Ai]: false }) },
      { capable: () => false },
      { privateVault: () => true },
    ];
    for (const over of closed) {
      const b = builder();
      const load = vi.fn(() => Promise.resolve(chunk()));
      const reasons: string[] = [];
      const ok = await attachAi(b, {
        vaultId: 'v',
        deps: deps(over),
        load,
        onClosed: (r) => reasons.push(r),
      });
      expect(ok).toBe(false);
      expect(load).not.toHaveBeenCalled(); // the live-ai chunk is never requested
      expect(b.addFeature).not.toHaveBeenCalled();
      expect(reasons).toHaveLength(1);
    }
  });

  it('with the default conditions of this build the function is off: no chunk, no call to the core', async () => {
    // A test build is made without MEMOBRAIN_AI, as a released one is: the build constant is off.
    const b = builder();
    const load = vi.fn(() => Promise.resolve(chunk()));
    const reasons: string[] = [];
    expect(await attachAi(b, { vaultId: 'v', load, onClosed: (r) => reasons.push(r) })).toBe(false);
    expect(reasons).toEqual(['build']);
    expect(load).not.toHaveBeenCalled();
    expect(b.addFeature).not.toHaveBeenCalled();
  });

  it('adds the feature with the provider of the core when every gate is open', async () => {
    const b = builder();
    const mod = chunk();
    const load = vi.fn(() => Promise.resolve(mod));
    expect(await attachAi(b, { vaultId: 'v', deps: deps(), load })).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    // the assistant, and the step that takes its flag off the toolbar over a selection (see feature.ts)
    expect(b.addFeature).toHaveBeenCalledTimes(2);
    expect(typeof b.addFeature.mock.calls[1]?.[0]).toBe('function');
    const [feature, config] = b.addFeature.mock.calls[0] as [
      unknown,
      { provider: unknown; diffReviewOnEnd: boolean },
    ];
    expect(feature).toBe(mod.ai);
    expect(typeof config.provider).toBe('function');
    expect(config.diffReviewOnEnd).toBe(true);
  });
});
