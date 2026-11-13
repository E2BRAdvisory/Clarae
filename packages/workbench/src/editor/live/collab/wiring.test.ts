// The Live editor's own opening, with the collaboration gates in their real places (ADR-0050): a
// profile with `collab: true` loads nothing, and only a build made for it plus a provider joins the room.
import { Feature } from '@clarae/api-client/features';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as chunks from '../chunks';
import { useManaged, unmanaged } from '../../../state/managed';
import { openLive } from '../testing/mounted';
import { collabProviders, registerCollabProvider, type CollabProvider } from './providers';

const loadCollab = vi.hoisted(() => vi.fn());
vi.mock('../chunks', async (original) => {
  const real = await original<typeof chunks>();
  loadCollab.mockImplementation(real.loadCollab);
  return { ...real, loadCollab };
});
vi.setConfig({ testTimeout: 30_000 });

const ROOM = { vaultId: 'v1', path: 'Notes/A.md' };
const join = vi.fn((): { leave: () => void } => ({ leave: () => undefined }));
const PROVIDER: CollabProvider = { id: 'test', join };

const profile = (collab: boolean): void =>
  useManaged.setState({ ...unmanaged, features: { [Feature.Collab]: collab } });

afterEach(() => {
  for (const p of [...collabProviders()]) registerCollabProvider(p)();
  useManaged.setState(unmanaged);
  vi.unstubAllEnvs();
  loadCollab.mockClear();
  join.mockClear();
});

describe('opening a note in Live', () => {
  it('a profile with collab: true does not load the chunk, with or without a provider', async () => {
    profile(true);
    for (const withProvider of [false, true]) {
      const off = withProvider ? registerCollabProvider(PROVIDER) : () => undefined;
      const live = await openLive('Hello\n', { collabRoom: () => ROOM });
      try {
        expect(live.editor.text()).toBe('Hello\n');
      } finally {
        live.dispose();
        off();
      }
    }
    // the build constant is off in this build: that is what keeps it closed even with a provider
    expect(loadCollab).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('a build made for it, a profile that says so and no provider still load nothing', async () => {
    vi.stubEnv('CLARAE_COLLAB', '1');
    profile(true);
    const live = await openLive('Hello\n', { collabRoom: () => ROOM });
    live.dispose();
    expect(loadCollab).not.toHaveBeenCalled();
  });

  it('the build, the flag and a provider together load it, join the note and leave with the editor', async () => {
    vi.stubEnv('CLARAE_COLLAB', '1');
    profile(true);
    const leave = vi.fn();
    join.mockReturnValue({ leave });
    registerCollabProvider(PROVIDER);
    const live = await openLive('Hello\n', { collabRoom: () => ROOM });
    try {
      expect(loadCollab).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(1));
      expect(join.mock.calls[0]).toEqual([expect.anything(), ROOM]);
      await new Promise((r) => setTimeout(r, 100));
      expect(live.editor.text()).toBe('Hello\n');
    } finally {
      live.dispose();
    }
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
  });

  it('a provider that fails does not keep the note from opening', async () => {
    vi.stubEnv('CLARAE_COLLAB', '1');
    profile(true);
    join.mockImplementation(() => {
      throw new Error('offline');
    });
    registerCollabProvider(PROVIDER);
    const live = await openLive('Hello\n', { collabRoom: () => ROOM });
    try {
      await vi.waitFor(() => expect(join).toHaveBeenCalled());
      expect(live.editor.text()).toBe('Hello\n');
    } finally {
      live.dispose();
    }
  });
});
