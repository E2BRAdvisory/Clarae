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

/**
 * Authorization Code + PKCE against Keycloak via oidc-client-ts. Tokens live in
 * sessionStorage only (gone when the tab closes). Renewal uses the refresh token
 * (no hidden iframe, which the CSP would block anyway); when a renewal fails the
 * access token simply expires and the user is signed out locally, so the route
 * guard sends them to sign in again.
 */
export function createOidcAuth(load: () => Promise<ClientConfig> = loadClientConfig): AuthService {
  let manager: Promise<UserManager> | undefined;

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
      // A failed renewal is not fatal until the token really expires.
      mgr.events.addAccessTokenExpired(() => {
        void mgr.removeUser();
      });
      return mgr;
    });
    return manager;
  };

  return {
    async getUser() {
      const mgr = await getManager();
      const u = await mgr.getUser();
      if (!u || u.expired) {
        if (u) await mgr.removeUser();
        return null;
      }
      return toAuthUser(u);
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
