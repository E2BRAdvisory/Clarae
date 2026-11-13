/** The signed-in user as the UI sees it. */
export interface AuthUser {
  sub: string;
  name: string;
  email?: string;
  /** Realm roles from the access token (`realm_access.roles`). */
  roles: string[];
  accessToken: string;
}

/** What the UI needs from the identity layer (OIDC in production, a double in e2e). */
export interface AuthService {
  /**
   * Current user from the session store, with an access token renewed when it is about to expire, or
   * null when signed out. Rejects (without signing out) when an expired token could not be renewed
   * because the identity provider did not answer: the next call tries again.
   */
  getUser(): Promise<AuthUser | null>;
  /** Starts the login redirect; `returnTo` is where the callback sends the user back. */
  signIn(returnTo: string): Promise<void>;
  /** Handles /auth/callback and resolves to the path to open next. */
  completeSignIn(): Promise<string>;
  /** Ends the session (redirects to the identity provider's logout). */
  signOut(): Promise<void>;
  /** Notified when the user changes without a page load: silent renew, expiry, logout elsewhere. */
  onUserChange(cb: (user: AuthUser | null) => void): () => void;
}

/** Realm role that unlocks the administration area. */
export const ADMIN_ROLE = 'clarae-admin';
