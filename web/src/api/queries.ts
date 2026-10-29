import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { unwrap, type Schemas } from '@memobrain/api-client';
import { useApi } from './context';

export type Share = Schemas['Share'];
export type Grant = Schemas['Grant'];
export type SharePermission = Schemas['SharePermission'];
export type PrincipalType = Grant['principal_type'];

export const keys = {
  me: ['me'] as const,
  usage: ['usage'] as const,
  vaults: ['vaults'] as const,
  devices: ['devices'] as const,
  shares: (scope: 'owned' | 'received') => ['shares', scope] as const,
  directory: (type: PrincipalType, q: string) => ['directory', type, q] as const,
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
  return features?.['web_workbench'] !== false;
}

export function useUsage() {
  const api = useApi();
  return useQuery({ queryKey: keys.usage, queryFn: () => unwrap(api.GET('/me/usage')) });
}

export function useVaults() {
  const api = useApi();
  return useQuery({ queryKey: keys.vaults, queryFn: () => unwrap(api.GET('/vaults')) });
}

export function useDevices() {
  const api = useApi();
  return useQuery({
    queryKey: keys.devices,
    queryFn: async () => (await unwrap(api.GET('/me/devices'))).items,
  });
}

export function useRevokeDevice() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      unwrap(api.DELETE('/me/devices/{deviceId}', { params: { path: { deviceId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.devices }),
  });
}

export function useShares(scope: 'owned' | 'received') {
  const api = useApi();
  return useQuery({
    queryKey: keys.shares(scope),
    queryFn: () => unwrap(api.GET('/shares', { params: { query: { scope } } })),
  });
}

/** Invalidates both share lists (an accepted invitation or a revoke changes either). */
function useInvalidateShares() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['shares'] });
}

export function useAnswerInvitation() {
  const api = useApi();
  const invalidate = useInvalidateShares();
  return useMutation({
    mutationFn: ({ shareId, accept }: { shareId: string; accept: boolean }) => {
      const params = { params: { path: { shareId } } };
      return unwrap(
        accept
          ? api.POST('/shares/{shareId}:accept', params)
          : api.POST('/shares/{shareId}:decline', params),
      );
    },
    onSuccess: invalidate,
  });
}

export function useRevokeShare() {
  const api = useApi();
  const invalidate = useInvalidateShares();
  return useMutation({
    mutationFn: (shareId: string) =>
      unwrap(api.DELETE('/shares/{shareId}', { params: { path: { shareId } } })),
    onSuccess: invalidate,
  });
}

interface GrantRef {
  shareId: string;
  principalType: PrincipalType;
  principalId: string;
}

export function usePutGrant() {
  const api = useApi();
  const invalidate = useInvalidateShares();
  return useMutation({
    mutationFn: ({
      shareId,
      principalType,
      principalId,
      permission,
    }: GrantRef & { permission: SharePermission }) =>
      unwrap(
        api.PUT('/shares/{shareId}/grants/{principalType}/{principalId}', {
          params: { path: { shareId, principalType, principalId } },
          body: { permission },
        }),
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteGrant() {
  const api = useApi();
  const invalidate = useInvalidateShares();
  return useMutation({
    mutationFn: ({ shareId, principalType, principalId }: GrantRef) =>
      unwrap(
        api.DELETE('/shares/{shareId}/grants/{principalType}/{principalId}', {
          params: { path: { shareId, principalType, principalId } },
        }),
      ),
    onSuccess: invalidate,
  });
}

/** Directory search for the "add access" form; only runs for a submitted query of 2+ characters. */
export function useDirectorySearch(type: PrincipalType, q: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.directory(type, q),
    enabled: q.length >= 2,
    queryFn: async (): Promise<{ id: string; name: string; detail?: string | undefined }[]> => {
      if (type === 'user') {
        const users = await unwrap(api.GET('/directory/users', { params: { query: { q } } }));
        return users.map((u) => ({
          id: u.id,
          name: u.display_name || u.username,
          detail: u.username,
        }));
      }
      const groups = await unwrap(api.GET('/directory/groups', { params: { query: { q } } }));
      return groups.map((g) => ({ id: g.id, name: g.name, detail: g.description }));
    },
  });
}
