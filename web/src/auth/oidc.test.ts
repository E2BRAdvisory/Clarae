import { beforeEach, describe, expect, it, vi } from 'vitest';

// A UserManager stand-in: the test sets the stored user and what a silent renewal returns.
interface FakeUser {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expired?: boolean;
  profile: { sub: string; name?: string };
}

const state = vi.hoisted(() => ({
  user: null as FakeUser | null,
  renewed: null as FakeUser | null | Error,
  silent: 0,
  removed: 0,
  expiredHandlers: [] as (() => void)[],
}));

vi.mock('oidc-client-ts', () => {
  class UserManager {
    events = {
      addAccessTokenExpired: (cb: () => void) => state.expiredHandlers.push(cb),
      addUserLoaded: () => undefined,
      addUserUnloaded: () => undefined,
      removeUserLoaded: () => undefined,
      removeUserUnloaded: () => undefined,
    };
    getUser() {
      return Promise.resolve(state.user);
    }
    removeUser() {
      state.removed++;
      state.user = null;
      return Promise.resolve();
    }
    signinSilent() {
      state.silent++;
      const r = state.renewed;
      if (r instanceof Error) return Promise.reject(r);
      if (r) state.user = r;
      return Promise.resolve(r);
    }
  }
  class WebStorageStateStore {}
  return { UserManager, WebStorageStateStore };
});

const { createOidcAuth } = await import('./oidc');

const load = () =>
  Promise.resolve({ issuer: 'https://idp.example/realms/m', webClientId: 'memobrain-web' });

const user = (over: Partial<FakeUser>): FakeUser => ({
  access_token: 'header.e30.sig',
  profile: { sub: 'u1', name: 'Alice' },
  expires_in: 300,
  expired: false,
  ...over,
});

beforeEach(() => {
  state.user = null;
  state.renewed = null;
  state.silent = 0;
  state.removed = 0;
  state.expiredHandlers = [];
});

describe('createOidcAuth getUser', () => {
  it('returns a valid user as is, without renewing', async () => {
    state.user = user({ access_token: 'a.e30.1', refresh_token: 'r1' });
    const auth = createOidcAuth(load as never);
    expect((await auth.getUser())?.accessToken).toBe('a.e30.1');
    expect(state.silent).toBe(0);
  });

  it('renews an expired token with the refresh token instead of signing out', async () => {
    state.user = user({ expired: true, expires_in: -10, refresh_token: 'r1' });
    state.renewed = user({ access_token: 'fresh.e30.2', refresh_token: 'r2' });
    const auth = createOidcAuth(load as never);
    expect((await auth.getUser())?.accessToken).toBe('fresh.e30.2');
    expect(state.silent).toBe(1);
    expect(state.removed).toBe(0);
  });

  it('renews a token about to expire, and shares one renewal between concurrent callers', async () => {
    state.user = user({ expires_in: 5, refresh_token: 'r1' });
    state.renewed = user({ access_token: 'fresh.e30.3' });
    const auth = createOidcAuth(load as never);
    const [a, b] = await Promise.all([auth.getUser(), auth.getUser()]);
    expect([a?.accessToken, b?.accessToken]).toEqual(['fresh.e30.3', 'fresh.e30.3']);
    expect(state.silent).toBe(1);
  });

  it('keeps a token about to expire when the renewal fails', async () => {
    state.user = user({ access_token: 'old.e30.4', expires_in: 5, refresh_token: 'r1' });
    state.renewed = new Error('network');
    const auth = createOidcAuth(load as never);
    expect((await auth.getUser())?.accessToken).toBe('old.e30.4');
    expect(state.removed).toBe(0);
  });

  it('signs out locally when the token expired and the renewal fails', async () => {
    state.user = user({ expired: true, expires_in: -1, refresh_token: 'r1' });
    state.renewed = new Error('invalid_grant');
    const auth = createOidcAuth(load as never);
    expect(await auth.getUser()).toBeNull();
    expect(state.removed).toBe(1);
  });

  it('signs out locally when the token expired and there is no refresh token', async () => {
    state.user = user({ expired: true, expires_in: -1 });
    const auth = createOidcAuth(load as never);
    expect(await auth.getUser()).toBeNull();
    expect(state.silent).toBe(0);
    expect(state.removed).toBe(1);
  });

  it('returns null when nobody is signed in', async () => {
    const auth = createOidcAuth(load as never);
    expect(await auth.getUser()).toBeNull();
  });
});

describe('createOidcAuth expiry event', () => {
  const fire = async () => {
    for (const cb of state.expiredHandlers) cb();
    await new Promise((r) => setTimeout(r, 0));
  };

  it('tries the refresh token before dropping the user', async () => {
    state.user = user({ expired: true, refresh_token: 'r1' });
    state.renewed = user({ access_token: 'fresh.e30.5' });
    const auth = createOidcAuth(load as never);
    await auth.getUser(); // creates the manager (and renews once)
    state.user = user({ expired: true, refresh_token: 'r2' });
    state.silent = 0;
    await fire();
    expect(state.silent).toBe(1);
    expect(state.removed).toBe(0);
  });

  it('drops the user when the renewal fails', async () => {
    state.user = user({});
    const auth = createOidcAuth(load as never);
    await auth.getUser();
    state.user = user({ expired: true, refresh_token: 'r1' });
    state.renewed = new Error('invalid_grant');
    await fire();
    expect(state.removed).toBe(1);
  });
});
