// The Live editor's own opening, with the assistant's gates in their real places (ADR-0050): a profile
// with `ai: true` loads nothing in a normal build, and only the build constant plus every other gate
// attach the feature (the chunk is fetched, the core is asked for `Status`, the note opens as it is).
import { Feature } from '@memobrain/api-client/features';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as chunks from '../chunks';
import { capabilitiesFor, usePlatform } from '../../../platform';
import { useManaged, unmanaged } from '../../../state/managed';
import { openLive } from '../testing/mounted';

const loadAi = vi.hoisted(() => vi.fn());
vi.mock('../chunks', async (original) => {
  const real = await original<typeof chunks>();
  loadAi.mockImplementation(real.loadAi);
  return { ...real, loadAi };
});
const status = vi.hoisted(() => vi.fn());
vi.mock('../../../../wailsjs/go/app/AIAPI', () => ({
  Status: status,
  Start: vi.fn(),
  Cancel: vi.fn(),
}));
vi.setConfig({ testTimeout: 30_000 });

const AVAILABLE = {
  available: true,
  reason: '',
  build: true,
  flag: true,
  private: false,
  configured: true,
  provider: 'test',
  model: 'test',
};

const profile = (ai: boolean): void =>
  useManaged.setState({ ...unmanaged, features: { [Feature.Ai]: ai } });
const capable = (on: boolean): void =>
  usePlatform.setState({ capabilities: { ...capabilitiesFor('desktop'), aiAssistant: on } });

beforeEach(() => {
  capable(true);
  status.mockResolvedValue(AVAILABLE);
});
afterEach(() => {
  useManaged.setState(unmanaged);
  usePlatform.setState({ capabilities: capabilitiesFor('desktop') });
  vi.unstubAllEnvs();
  loadAi.mockClear();
  status.mockReset();
});

/** `null`: a note that is in no vault. */
const open = (vaultId: string | null = 'v1') =>
  openLive('Hello\n', { vaultId: () => vaultId ?? undefined });

describe('opening a note in Live', () => {
  it('a profile with ai: true does not load the chunk nor ask the core, in a normal build', async () => {
    profile(true);
    const live = await open();
    try {
      expect(live.editor.text()).toBe('Hello\n');
    } finally {
      live.dispose();
    }
    // the build constant is off in this build: the first gate, before anything else is asked
    expect(loadAi).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('a build made for it with the flag off, the capability off or no vault still load nothing', async () => {
    vi.stubEnv('MEMOBRAIN_AI', '1');
    profile(false);
    (await open()).dispose();
    profile(true);
    capable(false);
    (await open()).dispose();
    capable(true);
    (await open(null)).dispose();
    expect(loadAi).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('a core that says it is not available keeps the chunk away', async () => {
    vi.stubEnv('MEMOBRAIN_AI', '1');
    profile(true);
    status.mockResolvedValue({ ...AVAILABLE, available: false, reason: 'not-configured' });
    const live = await open();
    try {
      expect(live.editor.text()).toBe('Hello\n');
    } finally {
      live.dispose();
    }
    expect(status).toHaveBeenCalledWith('v1');
    expect(loadAi).not.toHaveBeenCalled();
  });

  it('every gate open attaches it: the chunk is fetched and the note opens as it is', async () => {
    vi.stubEnv('MEMOBRAIN_AI', '1');
    profile(true);
    const live = await open();
    try {
      expect(status).toHaveBeenCalledWith('v1');
      expect(loadAi).toHaveBeenCalledTimes(1);
      expect(live.editor.text()).toBe('Hello\n');
    } finally {
      live.dispose();
    }
  });

  it('a core that fails does not keep the note from opening', async () => {
    vi.stubEnv('MEMOBRAIN_AI', '1');
    profile(true);
    status.mockRejectedValue(new Error('down'));
    const live = await open();
    try {
      expect(live.editor.text()).toBe('Hello\n');
    } finally {
      live.dispose();
    }
    expect(loadAi).not.toHaveBeenCalled();
  });
});
