import { Feature, FEATURE_DEFAULTS, featureEnabled } from '@memobrain/api-client/features';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { loadCollab } from '../chunks';
import { attachCollab } from './attach';
import { collabBuild } from './build';
import { checkCollab, defaultCollabDeps, type CollabGateDeps } from './gate';
import { collabProviders, registerCollabProvider, type CollabProvider } from './providers';

const PROVIDER: CollabProvider = { id: 'test', join: () => ({ leave: () => undefined }) };
const ROOM = { vaultId: 'v1', path: 'Note.md' };
const editor = () => ({ use: vi.fn().mockReturnThis() });
const chunk = () =>
  ({ collab: vi.fn(), startCollab: vi.fn() }) as unknown as Awaited<ReturnType<typeof loadCollab>>;

/** Every gate open, one at a time replaced. */
const deps = (over: Partial<CollabGateDeps> = {}): CollabGateDeps => ({
  build: () => true,
  features: () => ({ [Feature.Collab]: true }),
  providers: () => [PROVIDER],
  ...over,
});

afterEach(() => {
  for (const p of [...collabProviders()]) registerCollabProvider(p)(); // leaves no registration behind
});

describe('the flag and the build are off', () => {
  it('collab is declared with default false, so that an unknown-flag-is-on rule does not open it', () => {
    expect(FEATURE_DEFAULTS[Feature.Collab]).toBe(false);
    expect(featureEnabled({}, Feature.Collab)).toBe(false);
    expect(featureEnabled(undefined, Feature.Collab)).toBe(false);
  });

  it('the build constant is off in a build made without it (this one)', () => {
    expect(collabBuild()).toBe(false);
  });

  it('no provider is registered by the application', () => {
    expect(collabProviders()).toEqual([]);
    const gate = checkCollab(ROOM, defaultCollabDeps());
    expect(gate).toEqual({ open: false, closed: 'build' });
  });
});

describe('when collaboration may be offered', () => {
  it('is open only when the build, the flag and a provider are there, and the note has a room', () => {
    expect(checkCollab(ROOM, deps())).toEqual({ open: true, provider: PROVIDER });
  });

  const closed: [string, Partial<CollabGateDeps>, string][] = [
    ['the build constant is off', { build: () => false }, 'build'],
    ['the flag is off', { features: () => ({ [Feature.Collab]: false }) }, 'flag'],
    ['the profile does not mention it', { features: () => ({}) }, 'flag'],
    // the case of A-D12: a profile with `collab: true` and nothing else
    ['no provider is registered', { providers: () => [] }, 'provider'],
  ];
  for (const [name, over, why] of closed)
    it(`is closed when ${name}`, () => {
      expect(checkCollab(ROOM, deps(over))).toEqual({ open: false, closed: why });
    });

  it('is closed for a note that is not in a vault', () => {
    expect(checkCollab(undefined, deps())).toEqual({ open: false, closed: 'room' });
  });

  it('the flag of the profile, with the build constant on, still opens nothing without a provider', () => {
    // the build of a collaborative release, a profile that says collab: true, and no provider
    expect(checkCollab(ROOM, deps({ providers: () => collabProviders() }))).toEqual({
      open: false,
      closed: 'provider',
    });
  });

  it('uses the first provider registered, and a registration can be taken away', () => {
    const off = registerCollabProvider(PROVIDER);
    expect(collabProviders()).toEqual([PROVIDER]);
    off();
    expect(collabProviders()).toEqual([]);
  });
});

describe('attaching collaboration to the editor', () => {
  it('a profile with collab: true alone does not load the chunk', async () => {
    // the real default gates: build constant off, flag on, no provider
    const e = editor();
    const load = vi.fn(() => Promise.resolve(chunk()));
    const reasons: string[] = [];
    const attached = await attachCollab(e, {
      room: ROOM,
      deps: { ...defaultCollabDeps(), features: () => ({ [Feature.Collab]: true }) },
      load,
      onClosed: (r) => reasons.push(r),
    });
    expect(attached).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(e.use).not.toHaveBeenCalled();
    expect(reasons).toEqual(['build']);
  });

  it('loads nothing and adds nothing while any gate is closed', async () => {
    const closed: Partial<CollabGateDeps>[] = [
      { build: () => false },
      { features: () => ({}) },
      { features: () => ({ [Feature.Collab]: false }) },
      { providers: () => [] },
    ];
    for (const over of closed) {
      const e = editor();
      const load = vi.fn(() => Promise.resolve(chunk()));
      expect(await attachCollab(e, { room: ROOM, deps: deps(over), load })).toBeNull();
      expect(load).not.toHaveBeenCalled(); // the collab chunk is never requested
      expect(e.use).not.toHaveBeenCalled();
    }
    const load = vi.fn(() => Promise.resolve(chunk()));
    expect(await attachCollab(editor(), { room: undefined, deps: deps(), load })).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the chunk once and adds the plugin when every gate is open', async () => {
    const e = editor();
    const c = chunk();
    const load = vi.fn(() => Promise.resolve(c));
    const attached = await attachCollab(e, { room: ROOM, deps: deps(), load });
    expect(attached).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(e.use).toHaveBeenCalledWith(c.collab);
    // starting binds the provider and the room the gate chose
    const ctx = {} as never;
    await attached?.start(ctx, 'seed');
    expect(c.startCollab).toHaveBeenCalledWith(ctx, PROVIDER, ROOM, 'seed');
  });
});
