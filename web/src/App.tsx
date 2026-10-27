import { useMemo } from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  type MemoryRouterProps,
} from 'react-router';
import { useTranslation } from 'react-i18next';
import { ApiError, createClient, type MemobrainClient } from '@memobrain/api-client';
import { EmptyState, ToastProvider } from '@memobrain/ui';
import { ApiProvider } from './api/context';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { RequireAuth, RequireRole } from './auth/guards';
import { ADMIN_ROLE, type AuthService } from './auth/types';
import { Shell } from './layout/Shell';
import { AdminLayout } from './pages/Admin';
import { AuditPage } from './pages/admin/AuditPage';
import { ConfigDetailPage, ConfigListPage } from './pages/admin/ConfigPage';
import { GroupDetailPage, GroupsPage } from './pages/admin/GroupsPage';
import { LimitsPage } from './pages/admin/LimitsPage';
import { StoragePage } from './pages/admin/StoragePage';
import { UserDetailPage } from './pages/admin/UserDetailPage';
import { UsersPage } from './pages/admin/UsersPage';
import { AccountPage } from './pages/Account';
import { CallbackPage } from './pages/Callback';
import { DevicesPage } from './pages/Devices';
import { SharesPage } from './pages/Shares';
import { UsagePage } from './pages/Usage';
import { VaultsPage } from './pages/Vaults';

function NotFound() {
  const { t } = useTranslation();
  return <EmptyState title={t('notFound.title')}>{t('notFound.body')}</EmptyState>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/auth/callback" element={<CallbackPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/usage" replace />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="vaults" element={<VaultsPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="shares" element={<SharesPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route element={<RequireRole role={ADMIN_ROLE} />}>
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="storage" replace />} />
              <Route path="storage" element={<StoragePage />} />
              <Route path="limits" element={<LimitsPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="users/:id" element={<UserDetailPage />} />
              <Route path="groups" element={<GroupsPage />} />
              <Route path="groups/:id" element={<GroupDetailPage />} />
              <Route path="config" element={<ConfigListPage />} />
              <Route path="config/:id" element={<ConfigDetailPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

/** Wires the API client, server-state cache and toasts around the routes. */
export function DataLayer({
  client,
  children,
}: {
  client?: MemobrainClient;
  children: React.ReactNode;
}) {
  const { getAccessToken, signIn } = useAuth();
  const api = useMemo(
    () => client ?? createClient({ getAccessToken: () => getAccessToken() }),
    [client, getAccessToken],
  );
  const queryClient = useMemo(() => {
    // An expired or revoked session answers 401: restart the login instead of showing an error.
    const onError = (err: unknown) => {
      if (err instanceof ApiError && err.status === 401)
        signIn(`${location.pathname}${location.search}`);
    };
    return new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        queries: {
          staleTime: 15_000,
          retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
        },
      },
    });
  }, [signIn]);
  return (
    <ApiProvider client={api}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </ApiProvider>
  );
}

export function App({ auth, client }: { auth: AuthService; client?: MemobrainClient }) {
  return (
    <AuthProvider service={auth}>
      <DataLayer {...(client ? { client } : {})}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </DataLayer>
    </AuthProvider>
  );
}

/** Same tree on a MemoryRouter, for tests. */
export function TestApp({
  auth,
  client,
  router,
}: {
  auth: AuthService;
  client: MemobrainClient;
  router?: MemoryRouterProps;
}) {
  return (
    <AuthProvider service={auth}>
      <DataLayer client={client}>
        <MemoryRouter {...router}>
          <AppRoutes />
        </MemoryRouter>
      </DataLayer>
    </AuthProvider>
  );
}
