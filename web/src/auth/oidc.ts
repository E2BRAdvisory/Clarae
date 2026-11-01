import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
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

/**
 * Authorization Code + PKCE against Keycloak via oidc-client-ts. Tokens live in
 * sessionStorage only (gone when the tab closes). Renewal uses the refresh token
 * (oidc-client-ts' signinSilent takes the refresh_token grant when the user has
 * one; no hidden iframe, which the CSP would block anyway). A token that expired
 * while the page slept (a laptop lid, a background tab) is renewed on the next
 * getUser; only when the renewal fails is the user signed out locally, so the
 * route guard sends them to sign in again.
 */
export function createOidcAuth(load: () => Promise<ClientConfig> = loadClientConfig): AuthService {
  let manager: Promise<UserManager> | undefined;
  // One renewal at a time: concurrent callers (the core asks for tokens too) share it.
  let renewing: Promise<User | null> | null = null;

  const renew = (mgr: UserManager): Promise<User | null> => {
    renewing ??= mgr
      .signinSilent()
      .then((u) => (u && !u.expired ? u : null))
      .catch(() => null)
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };

  const getManager = (): Promise<UserManager> => {
    manager ??= load().then((cfg) => {
      const store = new WebStorageStateStore({ store: window.sessionStorage });
      const mgr = new UserManager({
        authority: cfg.issuer,
        client_id: cfg.webClientId,
        redirect_uri: `${window.location.origin}/auth/callback`,
        post_logout_redirect_uri: `${window.location.origin}/`,
        response_type: 'code',
        scope: 'openid profile email',
        userStore: store,
        stateStore: store,
        automaticSilentRenew: true,
        loadUserInfo: false,
      });
      // A failed automatic renewal is not fatal until the token really expires; even then the refresh
      // token may still be good (the timer does not run while the computer sleeps): try it once more.
      mgr.events.addAccessTokenExpired(() => {
        void (async () => {
          const u = await mgr.getUser();
          if (u?.refresh_token && (await renew(mgr))) return;
          await mgr.removeUser();
        })();
      });
      return mgr;
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
        const fresh = await renew(mgr);
        if (fresh) return toAuthUser(fresh);
      }
      // Still valid for a few seconds: use it while it lasts.
      if (!u.expired) return toAuthUser(u);
      await mgr.removeUser();
      return null;
    },
    async signIn(returnTo) {
      const mgr = await getManager();
      await mgr.signinRedirect({ state: { returnTo } });
    },
    async completeSignIn() {
      const mgr = await getManager();
      const u = await mgr.signinRedirectCallback();
      const state = u.state as { returnTo?: unknown } | undefined;
      const to = state?.returnTo;
      // Only same-origin paths: never an absolute URL smuggled through state.
      return typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to : '/';
    },
    async signOut() {
      const mgr = await getManager();
      await mgr.signoutRedirect();
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
