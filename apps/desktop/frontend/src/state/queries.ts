import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SearchSort } from '../app/api';

export const queryKeys = {
  recentVaults: ['recent-vaults'] as const,
  tree: (vaultId: string) => ['tree', vaultId] as const,
  note: (vaultId: string, path: string) => ['note', vaultId, path] as const,
  backlinks: (vaultId: string, path: string) => ['backlinks', vaultId, path] as const,
  search: (vaultId: string, q: string, sort: SearchSort) => ['search', vaultId, q, sort] as const,
};

export function useRecentVaults() {
  return useQuery({ queryKey: queryKeys.recentVaults, queryFn: () => api.vault.listRecent() });
}

export function useTree(vaultId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tree(vaultId ?? ''),
    queryFn: () => api.vault.listTree(vaultId ?? ''),
    enabled: !!vaultId,
  });
}

export function useNote(vaultId: string | undefined, path: string | null) {
  return useQuery({
    queryKey: queryKeys.note(vaultId ?? '', path ?? ''),
    queryFn: () => api.vault.readNote(vaultId ?? '', path ?? ''),
    enabled: !!vaultId && !!path,
    staleTime: Infinity, // the editor owns the content once loaded; refetch explicitly
  });
}

export function useBacklinks(vaultId: string | undefined, path: string | null) {
  return useQuery({
    queryKey: queryKeys.backlinks(vaultId ?? '', path ?? ''),
    queryFn: async () => {
      const id = vaultId ?? '';
      const p = path ?? '';
      const [linked, mentions] = await Promise.all([
        api.links.backlinks(id, p),
        api.links.mentions(id, p),
      ]);
      return { linked, mentions };
    },
    enabled: !!vaultId && !!path,
  });
}

export function useSearch(vaultId: string | undefined, q: string, sort: SearchSort) {
  return useQuery({
    queryKey: queryKeys.search(vaultId ?? '', q, sort),
    queryFn: () => api.search.query(vaultId ?? '', q, sort),
    enabled: !!vaultId && q.trim().length > 0,
    retry: false,
  });
}

/** Invalidation helpers used by event handlers and mutations. */
export function useInvalidate() {
  const qc = useQueryClient();
  return {
    tree: (vaultId: string) => qc.invalidateQueries({ queryKey: queryKeys.tree(vaultId) }),
    note: (vaultId: string, path: string) =>
      qc.invalidateQueries({ queryKey: queryKeys.note(vaultId, path) }),
    search: (vaultId: string) => qc.invalidateQueries({ queryKey: ['search', vaultId] }),
    backlinks: (vaultId: string) => qc.invalidateQueries({ queryKey: ['backlinks', vaultId] }),
    recent: () => qc.invalidateQueries({ queryKey: queryKeys.recentVaults }),
  };
}
