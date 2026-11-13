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
  /** What signinSilent answers; a list is consumed one answer per call (the last one repeats). */
  renewed: null as FakeUser | null | Error | (FakeUser | Error)[],
  silent: 0,
  removed: 0,
  expiredHandlers: [] as (() => void)[],
}));

vi.mock('oidc-client-ts', () => {
  // The error oidc-client-ts throws when the identity provider answers with an OAuth error.
  class ErrorResponse extends Error {
    error: string;
    constructor(args: { error: string }) {
      super(args.error);
      this.error = args.error;
    }
  }
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
      const r = Array.isArray(state.renewed)
        ? state.renewed.length > 1
          ? state.renewed.shift()
          : state.renewed[0]
        : state.renewed;
      if (r instanceof Error) return Promise.reject(r);
      if (r) state.user = r;
      return Promise.resolve(r);
    }
  }
  class WebStorageStateStore {}
  return { ErrorResponse, UserManager, WebStorageStateStore };
});

const { ErrorResponse } = await import('oidc-client-ts');
const { createOidcAuth, SessionUnavailableError, sessionEnded } = await import('./oidc');

/** An OAuth error answer of the identity provider (`invalid_grant`: the session is over). */
const oauthError = (error: string) => new ErrorResponse({ error });
/** Retries without waiting, for the tests. */
const auth = (renewRetryMs: number[] = [0, 0]) => createOidcAuth(load as never, [], renewRetryMs);

const load = () =>
  Promise.resolve({ issuer: 'https://idp.example/realms/m', webClientId: 'clarae-web' });

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

  it('signs out locally when the token expired and the identity provider refuses the renewal', async () => {
    state.user = user({ expired: true, expires_in: -1, refresh_token: 'r1' });
    state.renewed = oauthError('invalid_grant');
    expect(await auth().getUser()).toBeNull();
    expect(state.silent).toBe(1); // a refusal is not retried
    expect(state.removed).toBe(1);
  });

  it('keeps the session when the identity provider cannot be reached, and retries with a backoff', async () => {
    state.user = user({ expired: true, expires_in: -1, refresh_token: 'r1' });
    state.renewed = new TypeError('Failed to fetch');
    const a = auth([0, 0]);
    const err = await a.getUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionUnavailableError);
    expect(state.silent).toBe(3); // the first attempt and two retries
    expect(state.removed).toBe(0);
    expect(state.user).not.toBeNull();
    // The network is back: the next call renews with the refresh token that was kept.
    state.renewed = user({ access_token: 'back.e30.9' });
    expect((await a.getUser())?.accessToken).toBe('back.e30.9');
  });

  it('recovers within one call when a retry succeeds', async () => {
    state.user = user({ expired: true, expires_in: -1, refresh_token: 'r1' });
    state.renewed = [new Error('Bad Gateway (502)'), user({ access_token: 'retry.e30.8' })];
    expect((await auth().getUser())?.accessToken).toBe('retry.e30.8');
    expect(state.silent).toBe(2);
    expect(state.removed).toBe(0);
  });

  it('does not wait for retries while the browser is offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      state.user = user({ expired: true, expires_in: -1, refresh_token: 'r1' });
      state.renewed = new TypeError('Failed to fetch');
      await expect(auth([60_000]).getUser()).rejects.toBeInstanceOf(SessionUnavailableError);
      expect(state.silent).toBe(1);
      expect(state.removed).toBe(0);
    } finally {
      online.mockRestore();
    }
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

  it('drops the user when the identity provider refuses the renewal', async () => {
    state.user = user({});
    await auth().getUser();
    state.user = user({ expired: true, refresh_token: 'r1' });
    state.renewed = oauthError('invalid_grant');
    await fire();
    expect(state.removed).toBe(1);
  });

  it('keeps the user when the renewal fails for the network', async () => {
    state.user = user({});
    await auth([]).getUser();
    state.user = user({ expired: true, refresh_token: 'r1' });
    state.renewed = new TypeError('Failed to fetch');
    await fire();
    expect(state.silent).toBe(1);
    expect(state.removed).toBe(0);
  });
});

describe('sessionEnded', () => {
  it.each([
    [oauthError('invalid_grant'), true],
    [oauthError('login_required'), true],
    [oauthError('invalid_client'), true],
    [oauthError('temporarily_unavailable'), false],
    [oauthError('server_error'), false],
    [new TypeError('Failed to fetch'), false],
    [new Error('Network timed out'), false],
    [new Error('Bad Gateway (502)'), false],
  ])('%s -> %s', (err, want) => {
    expect(sessionEnded(err)).toBe(want);
  });
});

describe('createOidcAuth client configuration', () => {
  it('retries a failed configuration read and does not remember the failure', async () => {
    state.user = user({});
    let calls = 0;
    let down = true;
    const flaky = () => {
      calls++;
      return down ? Promise.reject(new Error('502')) : load();
    };
    const auth = createOidcAuth(flaky as never, [0]);
    await expect(auth.getUser()).rejects.toThrow('502');
    expect(calls).toBe(2); // the first attempt and one retry
    down = false;
    await expect(auth.getUser()).resolves.toMatchObject({ sub: 'u1' }); // the next call starts again
    expect(calls).toBe(3);
  });

  it('lets a sign-in that cannot start fail instead of hanging', async () => {
    const auth = createOidcAuth(() => Promise.reject(new Error('offline')), []);
    await expect(auth.signIn('/vaults')).rejects.toThrow('offline');
  });
});
