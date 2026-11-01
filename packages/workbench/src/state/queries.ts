import { useMemo } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { extract } from '@memobrain/markdown';
import { api, type Entry, type SearchSort } from '../app/api';

export const queryKeys = {
  recentVaults: ['recent-vaults'] as const,
  tree: (vaultId: string) => ['tree', vaultId] as const,
  note: (vaultId: string, path: string) => ['note', vaultId, path] as const,
  backlinks: (vaultId: string, path: string) => ['backlinks', vaultId, path] as const,
  search: (vaultId: string, q: string, sort: SearchSort) => ['search', vaultId, q, sort] as const,
  tags: (vaultId: string) => ['tags', vaultId] as const,
  propkeys: (vaultId: string) => ['propkeys', vaultId] as const,
  outline: (vaultId: string, path: string) => ['outline', vaultId, path] as const,
};

export function useTags(vaultId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tags(vaultId ?? ''),
    queryFn: () => api.tags.list(vaultId ?? ''),
    enabled: !!vaultId,
  });
}

export function usePropertyKeys(vaultId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.propkeys(vaultId ?? ''),
    queryFn: () => api.properties.keys(vaultId ?? ''),
    enabled: !!vaultId,
  });
}

/** Headings of a note as last saved (re-read when the file changes on disk). */
export function useOutline(vaultId: string | undefined, path: string | null) {
  return useQuery({
    queryKey: queryKeys.outline(vaultId ?? '', path ?? ''),
    queryFn: async () =>
      extract(path ?? '', (await api.vault.readNote(vaultId ?? '', path ?? '')).content).headings,
    enabled: !!vaultId && !!path && (path ?? '').endsWith('.md'),
  });
}

export function useRecentVaults() {
  return useQuery({ queryKey: queryKeys.recentVaults, queryFn: () => api.vault.listRecent() });
}

const treeIndexes = new WeakMap<readonly Entry[], Map<string, Entry>>();

/** The cached tree entry of a file (no fetch): its size and mtime tell a cached copy is current. */
export function treeEntry(qc: QueryClient, vaultId: string, path: string): Entry | undefined {
  const tree = qc.getQueryData<Entry[]>(queryKeys.tree(vaultId));
  if (!tree) return undefined;
  let index = treeIndexes.get(tree);
  if (!index) {
    index = new Map(tree.map((e) => [e.path, e]));
    treeIndexes.set(tree, index);
  }
  return index.get(path);
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
      const [linked, mentions, outgoing] = await Promise.all([
        api.links.backlinks(id, p),
        api.links.mentions(id, p),
        api.links.outgoing(id, p),
      ]);
      return { linked, mentions, outgoing };
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
  // Stable per client, so effects depending on it do not re-subscribe on every render.
  return useMemo(() => invalidators(qc), [qc]);
}

function invalidators(qc: QueryClient) {
  return {
    tree: (vaultId: string) => qc.invalidateQueries({ queryKey: queryKeys.tree(vaultId) }),
    note: (vaultId: string, path: string) =>
      qc.invalidateQueries({ queryKey: queryKeys.note(vaultId, path) }),
    search: (vaultId: string) => qc.invalidateQueries({ queryKey: ['search', vaultId] }),
    backlinks: (vaultId: string) => qc.invalidateQueries({ queryKey: ['backlinks', vaultId] }),
    tags: (vaultId: string) => qc.invalidateQueries({ queryKey: queryKeys.tags(vaultId) }),
    propkeys: (vaultId: string) => qc.invalidateQueries({ queryKey: queryKeys.propkeys(vaultId) }),
    outline: (vaultId: string) => qc.invalidateQueries({ queryKey: ['outline', vaultId] }),
    recent: () => qc.invalidateQueries({ queryKey: queryKeys.recentVaults }),
  };
}
