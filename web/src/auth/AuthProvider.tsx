import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ADMIN_ROLE, type AuthService, type AuthUser } from './types';

export interface AuthState {
  /** `loading` until the session store has been read. */
  status: 'loading' | 'ready';
  user: AuthUser | null;
  isAdmin: boolean;
  signIn: (returnTo?: string) => void;
  signOut: () => void;
  completeSignIn: () => Promise<string>;
  getAccessToken: () => string | undefined;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ service, children }: { service: AuthService; children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    let alive = true;
    service
      .getUser()
      .then((u) => alive && setUser(u))
      .catch(() => alive && setUser(null))
      .finally(() => alive && setStatus('ready'));
    const off = service.onUserChange((u) => alive && setUser(u));
    return () => {
      alive = false;
      off();
    };
  }, [service]);

  const signIn = useCallback(
    (returnTo = '/') => {
      void service.signIn(returnTo);
    },
    [service],
  );
  const signOut = useCallback(() => void service.signOut(), [service]);
  const completeSignIn = useCallback(async () => {
    const to = await service.completeSignIn();
    setUser(await service.getUser());
    return to;
  }, [service]);
  const token = user?.accessToken;
  const getAccessToken = useCallback(() => token, [token]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      isAdmin: user?.roles.includes(ADMIN_ROLE) ?? false,
      signIn,
      signOut,
      completeSignIn,
      getAccessToken,
    }),
    [status, user, signIn, signOut, completeSignIn, getAccessToken],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
