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
  /**
   * Set when the session could not be read or the sign-in could not start (the cloud did not answer
   * with its configuration, the identity provider is unreachable): the guard shows it with a retry.
   */
  error: Error | null;
  /** Reads the session again after an error. */
  retry: () => void;
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
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    service
      .getUser()
      .then((u) => {
        if (!alive) return;
        setUser(u);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setUser(null);
        setError(asError(e));
      })
      .finally(() => alive && setStatus('ready'));
    const off = service.onUserChange((u) => alive && setUser(u));
    return () => {
      alive = false;
      off();
    };
  }, [service, attempt]);

  const signIn = useCallback(
    (returnTo = '/') => {
      service.signIn(returnTo).catch((e: unknown) => setError(asError(e)));
    },
    [service],
  );
  const retry = useCallback(() => {
    setError(null);
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, []);
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
      error,
      retry,
      isAdmin: user?.roles.includes(ADMIN_ROLE) ?? false,
      signIn,
      signOut,
      completeSignIn,
      getAccessToken,
    }),
    [status, user, error, retry, signIn, signOut, completeSignIn, getAccessToken],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
