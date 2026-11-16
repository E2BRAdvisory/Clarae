import { ErrorResponse, UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { loadClientConfig, type ClientConfig } from './config';
import { rolesFromAccessToken } from './jwt';
import type { AuthService, AuthUser } from './types';

function toAuthUser(u: User): AuthUser {
  const email = u.profile.email;
  return {
    sub: u.profile.sub,
    name: u.profile.name ?? u.profile.preferred_username ?? email ?? u.profile.sub,
    ...(email ? { email } : {}),
    roles: rolesFromAccessToken(u.access_token),
    accessToken: u.access_token,
  };
}

/** An access token that expires within this many seconds is renewed before it is handed out. */
export const RENEW_MARGIN_S = 30;

/** Pauses between the attempts to read the client configuration (a cloud restarting, a blip). */
export const CONFIG_RETRY_MS = [300, 1000];

/** Pauses between the attempts to renew a token when the identity provider could not be reached. */
export const RENEW_RETRY_MS = [1000, 4000];

/**
 * The session could not be renewed because the identity provider did not answer (no network, a
 * timeout, a 5xx): the session itself may still be good, so it is kept and the next call tries again.
 */
export class SessionUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `the sign-in service cannot be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.name = 'SessionUnavailableError';
  }
}

/** OAuth errors that say "try again later" rather than "this session is over" (RFC 6749 §5.2 and §4.1.2.1). */
const TRANSIENT_OAUTH_ERRORS = new Set(['temporarily_unavailable', 'server_error']);

/**
 * True when a failed renewal means the session is really over: the identity provider answered with an
 * OAuth error (`invalid_grant` for a revoked or expired refresh token, `login_required`, `invalid_client`…).
 * Anything else (a fetch that failed, a timeout, a 5xx page, a captive portal) says nothing about the
 * session and must not sign the user out.
 */
export function sessionEnded(err: unknown): boolean {
  return err instanceof ErrorResponse && !TRANSIENT_OAUTH_ERRORS.has(err.error ?? '');
}

/**
 * Set by an explicit sign-out and read by the next sign-in, which then asks the identity provider for the
 * credentials (`prompt=login`) even when an SSO session survived (a broker, an older realm). localStorage,
 * not sessionStorage: it must outlive the tab. Cleared when a sign-in completes (ADR-0058).
 */
export const FORCE_LOGIN_KEY = 'clarae.auth.forceLogin';

/** localStorage may be blocked (privacy modes, a full quota): the marker is then simply not kept. */
function markerSet(): boolean {
  try {
    return window.localStorage.getItem(FORCE_LOGIN_KEY) !== null;
  } catch {
    return false;
  }
}
function setMarker(): void {
  try {
    window.localStorage.setItem(FORCE_LOGIN_KEY, '1');
  } catch {
    // not kept: the next sign-in simply does not force the prompt
  }
}
function clearMarker(): void {
  try {
    window.localStorage.removeItem(FORCE_LOGIN_KEY);
  } catch {
    // nothing to clear
  }
}

/** Where the page goes without the identity provider's help (a seam: tests cannot navigate). */
export const navigation = { assign: (href: string) => window.location.assign(href) };

type Renewal =
  { kind: 'ok'; user: User } | { kind: 'ended' } | { kind: 'unavailable'; error: unknown };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Authorization Code + PKCE against Keycloak via oidc-client-ts. Tokens live in
 * sessionStorage only (gone when the tab closes). Renewal uses the refresh token
 * (oidc-client-ts' signinSilent takes the refresh_token grant when the user has
 * one; no hidden iframe, which the CSP would block anyway). A token that expired
 * while the page slept (a laptop lid, a background tab) is renewed on the next
 * getUser. Only when the identity provider refuses the renewal (sessionEnded) is
 * the user signed out locally, so the route guard sends them to sign in again; a
 * renewal that fails for the network is retried with a backoff and, if it still
 * fails, getUser rejects with a SessionUnavailableError and keeps the session
 * for the next call (a short disconnection must not throw the session away).
 */
export function createOidcAuth(
  load: () => Promise<ClientConfig> = loadClientConfig,
  retryMs: readonly number[] = CONFIG_RETRY_MS,
  renewRetryMs: readonly number[] = RENEW_RETRY_MS,
): AuthService {
  let manager: Promise<UserManager> | undefined;
  /** The client id of the configuration the manager was made with (the sign-out request names it). */
  let webClientId = '';

  /** The client configuration, retried a few times; a failure is not remembered (see getManager). */
  const loadConfig = async (): Promise<ClientConfig> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await load();
      } catch (e) {
        const wait = retryMs[attempt];
        if (wait === undefined) throw e;
        await sleep(wait);
      }
    }
  };
  // One renewal at a time: concurrent callers (the core asks for tokens too) share it.
  let renewing: Promise<Renewal> | null = null;

  const attemptRenewal = async (mgr: UserManager, retries: readonly number[]): Promise<Renewal> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const u = await mgr.signinSilent();
        return u && !u.expired ? { kind: 'ok', user: u } : { kind: 'ended' };
      } catch (error) {
        if (sessionEnded(error)) return { kind: 'ended' };
        const wait = retries[attempt];
        // Offline: waiting will not help this call; the next one tries again.
        if (wait === undefined || navigator.onLine === false) return { kind: 'unavailable', error };
        await sleep(wait);
      }
    }
  };

  /**
   * `retry`: wait and try again when the identity provider cannot be reached. Only for a token that
   * expired: one that is still valid for a few seconds is better used at once than waited on.
   */
  const renew = (mgr: UserManager, retry: boolean): Promise<Renewal> => {
    renewing ??= attemptRenewal(mgr, retry ? renewRetryMs : []).finally(() => {
      renewing = null;
    });
    return renewing;
  };

  const getManager = (): Promise<UserManager> => {
    manager ??= loadConfig().then((cfg) => {
      webClientId = cfg.webClientId;
      const store = new WebStorageStateStore({ store: window.sessionStorage });
      const mgr = new UserManager({
        authority: cfg.issuer,
        client_id: cfg.webClientId,
        redirect_uri: `${window.location.origin}/auth/callback`,
        // Where the identity provider sends the browser back after the sign-out: a public page that does
        // not sign in again by itself, so that signing out is visible (the guard would restart the login).
        post_logout_redirect_uri: `${window.location.origin}/signed-out`,
        response_type: 'code',
        scope: 'openid profile email',
        userStore: store,
        stateStore: store,
        automaticSilentRenew: true,
        loadUserInfo: false,
      });
      // A failed automatic renewal is not fatal until the token really expires; even then the refresh
      // token may still be good (the timer does not run while the computer sleeps): try it once more.
      // The user is dropped only when the identity provider refuses the renewal: without network the
      // session is kept, and the next getUser (any API call) tries again.
      mgr.events.addAccessTokenExpired(() => {
        void (async () => {
          const u = await mgr.getUser();
          if (!u) return;
          if (u.refresh_token && (await renew(mgr, true)).kind !== 'ended') return;
          await mgr.removeUser();
        })().catch(() => undefined);
      });
      return mgr;
    });
    // A failed load is not kept: the next call (a retry, the next sign-in) starts again.
    const current = manager;
    current.catch(() => {
      if (manager === current) manager = undefined;
    });
    return manager;
  };

  return {
    async getUser() {
      const mgr = await getManager();
      const u = await mgr.getUser();
      if (!u) return null;
      const expiring = u.expired || (u.expires_in !== undefined && u.expires_in < RENEW_MARGIN_S);
      if (!expiring) return toAuthUser(u);
      if (u.refresh_token) {
        const r = await renew(mgr, u.expired === true);
        if (r.kind === 'ok') return toAuthUser(r.user);
        // Still valid for a few seconds: use it while it lasts.
        if (!u.expired) return toAuthUser(u);
        // The identity provider could not be reached: the session is kept for the next call.
        if (r.kind === 'unavailable') throw new SessionUnavailableError(r.error);
      }
      if (!u.expired) return toAuthUser(u);
      await mgr.removeUser();
      return null;
    },
    async signIn(returnTo) {
      const mgr = await getManager();
      await mgr.signinRedirect({
        state: { returnTo },
        ...(markerSet() ? { prompt: 'login' } : {}),
      });
    },
    async completeSignIn() {
      const mgr = await getManager();
      const u = await mgr.signinRedirectCallback();
      clearMarker();
      const state = u.state as { returnTo?: unknown } | undefined;
      const to = state?.returnTo;
      // Only same-origin paths: never an absolute URL smuggled through state.
      return typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : '/';
    },
    async signOut() {
      const mgr = await getManager();
      // The parameters are explicit, not left to what the library remembers: Keycloak gets the same
      // request with an ID token, and `client_id` which the library only adds when there is no hint.
      const u = await mgr.getUser();
      setMarker();
      // The refresh token dies with the session: a sign-out that leaves it valid would be a pretence.
      // But best effort, and apart from the sign-out: with `revokeTokensOnSignout` a revocation that
      // fails (offline, a 5xx, CORS) aborts the library's sign-out before it removes the user, which
      // would leave the user signed in. The identity provider's session ends in any case.
      try {
        await mgr.revokeTokens();
      } catch (e) {
        console.warn('the tokens could not be revoked; signing out anyway', e);
      }
      try {
        await mgr.signoutRedirect({
          ...(u?.id_token ? { id_token_hint: u.id_token } : {}),
          post_logout_redirect_uri: `${window.location.origin}/signed-out`,
          extraQueryParams: { client_id: webClientId },
        });
      } catch (e) {
        // The identity provider cannot be reached (discovery, the end-session endpoint): the user is
        // signed out here all the same, and the marker makes the next sign-in ask for the credentials.
        console.warn('the identity provider could not be asked to end the session', e);
        try {
          await mgr.removeUser();
        } catch {
          // storage unavailable: the page is left all the same
        }
        navigation.assign('/signed-out');
      }
    },
    onUserChange(cb) {
      let off: (() => void) | undefined;
      let cancelled = false;
      void getManager().then((mgr) => {
        if (cancelled) return;
        const loaded = (u: User) => cb(toAuthUser(u));
        const unloaded = () => cb(null);
        mgr.events.addUserLoaded(loaded);
        mgr.events.addUserUnloaded(unloaded);
        off = () => {
          mgr.events.removeUserLoaded(loaded);
          mgr.events.removeUserUnloaded(unloaded);
        };
      });
      return () => {
        cancelled = true;
        off?.();
      };
    },
  };
}
