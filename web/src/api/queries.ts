import { useMemo } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { unwrap, type Schemas } from '@memobrain/api-client';
import { Feature } from '@memobrain/api-client/features';
import { cloudKeys, RestCloudPort, useFeature } from '@memobrain/cloud-features';
import { useAuth } from '../auth/AuthProvider';
import { ADMIN_ROLE } from '../auth/types';
import { useApi } from './context';

export type Share = Schemas['Share'];

/**
 * The console's own query keys. Vaults, shares and feature flags are NOT here: the console reads
 * them through the cache of @memobrain/cloud-features (cloudKeys), the one its components use and
 * invalidate, so every view of the same resource is one cache entry and a change refreshes them all.
 */
export const keys = {
  me: ['me'] as const,
  /** The full effective configuration (useVaultLockMs); the flags come from cloudKeys.features. */
  effectiveConfig: ['config', 'effective'] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => unwrap(api.GET('/me')) });
}

/**
 * Whether the signed-in user may use the administration area. The role is the one of /me, the row
 * the server authorizes with (users.role, ADR-0041 §1), not the realm role of the access token,
 * which may lag behind a change for the token's lifetime. `pending` while /me has not answered;
 * when it cannot be read the token's role is the fallback (the server checks every call anyway).
 */
export function useAdminAccess(): { isAdmin: boolean; pending: boolean } {
  const me = useMe();
  const { user } = useAuth();
  if (me.data) return { isAdmin: me.data.role === 'admin', pending: false };
  if (me.isPending) return { isAdmin: false, pending: true };
  return { isAdmin: user?.roles.includes(ADMIN_ROLE) ?? false, pending: false };
}

/** A port over the API for reading (its cache is shared with useCloudPort's: same port id). */
function useReadPort(): RestCloudPort {
  const api = useApi();
  return useMemo(() => new RestCloudPort(api), [api]);
}

/** Whether the administrator allows opening vaults in the browser (feature `web_workbench`, on by default). */
export function useWorkbenchAllowed(): boolean {
  return useFeature(useReadPort(), Feature.WebWorkbench);
}

export function useVaults() {
  const port = useReadPort();
  return useQuery({ queryKey: cloudKeys.vaults(port), queryFn: () => port.listVaults() });
}

export function useShares(scope: 'owned' | 'received') {
  const port = useReadPort();
  return useQuery({
    queryKey: cloudKeys.sharesOf(port, scope),
    queryFn: () => port.listShares(scope),
  });
}

/**
 * Refreshes what the signed-in user sees of the cloud (vaults, shares, usage, devices, groups,
 * feature flags) and of themselves (/me, the effective configuration): after an administrator's
 * change that may concern their own account.
 */
export function invalidateOwnViews(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.me }),
    qc.invalidateQueries({ queryKey: keys.effectiveConfig }),
    qc.invalidateQueries({ queryKey: ['cloud-features'] }),
  ]).then(() => undefined);
}

/** Used when the configuration sets no idle lock (or 0, "never" on a device): ADR-0029's default. */
export const DEFAULT_CONSOLE_LOCK_MINUTES = 15;

/**
 * How long the console keeps the keys of a private vault unlocked and unused (the private ZIP
 * export): the idle time the core locks a private vault after, `security.vault_lock_minutes` of
 * the effective configuration, or DEFAULT_CONSOLE_LOCK_MINUTES when it sets none. The console never
 * keeps keys without a limit, even where a device may.
 */
export function useVaultLockMs(): number {
  const api = useApi();
  const q = useQuery({
    queryKey: keys.effectiveConfig,
    queryFn: () => unwrap(api.GET('/config/effective')),
    staleTime: 60_000,
  });
  const security = (q.data?.config as { security?: Record<string, unknown> } | undefined)?.security;
  const minutes = security?.['vault_lock_minutes'];
  const m =
    typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? Math.min(minutes, 1440)
      : DEFAULT_CONSOLE_LOCK_MINUTES;
  return m * 60_000;
}
