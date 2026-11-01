import { useQuery } from '@tanstack/react-query';
import { unwrap, type Schemas } from '@memobrain/api-client';
import { Feature, featureEnabled } from '@memobrain/api-client/features';
import { useApi } from './context';

export type Share = Schemas['Share'];

export const keys = {
  me: ['me'] as const,
  vaults: ['vaults'] as const,
  shares: (scope: 'owned' | 'received') => ['shares', scope] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => unwrap(api.GET('/me')) });
}

/** Whether the administrator allows opening vaults in the browser (feature `web_workbench`, on by default). */
export function useWorkbenchAllowed(): boolean {
  const api = useApi();
  const q = useQuery({
    queryKey: ['config', 'effective'],
    queryFn: () => unwrap(api.GET('/config/effective')),
    staleTime: 60_000,
  });
  const features = (q.data?.config as { features?: Record<string, unknown> } | undefined)?.features;
  return featureEnabled(features, Feature.WebWorkbench);
}

export function useVaults() {
  const api = useApi();
  return useQuery({ queryKey: keys.vaults, queryFn: () => unwrap(api.GET('/vaults')) });
}

export function useShares(scope: 'owned' | 'received') {
  const api = useApi();
  return useQuery({
    queryKey: keys.shares(scope),
    queryFn: () => unwrap(api.GET('/shares', { params: { query: { scope } } })),
  });
}
