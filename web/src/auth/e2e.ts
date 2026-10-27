// Test double for the identity layer. It is only reachable from main.tsx behind
// `import.meta.env.VITE_E2E`, which Vite replaces with a constant: production
// builds drop this module entirely (checked by scripts in docs/web-ui.md).
import type { AuthService, AuthUser } from './types';

export const E2E_USER_KEY = 'memobrain.e2e.user';

export function createE2EAuth(): AuthService {
  const read = (): AuthUser | null => {
    const raw = window.sessionStorage.getItem(E2E_USER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { name?: string; roles?: string[] };
    return {
      sub: 'e2e-user',
      name: p.name ?? 'E2E User',
      roles: p.roles ?? [],
      accessToken: 'e2e-token',
    };
  };
  return {
    getUser: () => Promise.resolve(read()),
    signIn: (returnTo) => {
      window.location.assign(`/e2e-signin?returnTo=${encodeURIComponent(returnTo)}`);
      return Promise.resolve();
    },
    completeSignIn: () => Promise.resolve('/'),
    signOut: () => {
      window.sessionStorage.removeItem(E2E_USER_KEY);
      window.location.assign('/e2e-signed-out');
      return Promise.resolve();
    },
    onUserChange: () => () => {},
  };
}
