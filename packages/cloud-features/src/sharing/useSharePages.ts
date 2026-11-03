import { useEffect, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { cloudKeys } from '../CloudVaultsTable';
import type { CloudPort, Share } from '../port';

export interface SharePagesOptions {
  /** Off while the `sharing` feature is off or unknown. */
  enabled?: boolean | undefined;
  /**
   * Read every page at once: for a view that filters the shares (those of one vault), where a page
   * says nothing about what the next ones hold.
   */
  all?: boolean | undefined;
}

/**
 * The shares of a scope, newest first, a page at a time (GET /shares is paginated): `shares` are
 * the pages read so far, without duplicates (a share created between two pages can show up on
 * both), and `loadMore` reads the next page while `hasMore`. One cache entry per port and scope
 * (cloudKeys.sharesOf), which every change invalidates.
 */
export function useSharePages(
  port: CloudPort,
  scope: 'owned' | 'received',
  { enabled = true, all = false }: SharePagesOptions = {},
) {
  const query = useInfiniteQuery({
    queryKey: cloudKeys.sharesOf(port, scope),
    initialPageParam: '',
    queryFn: ({ pageParam }) => port.listShares(scope, pageParam || undefined),
    getNextPageParam: (last) => last.next_cursor || undefined,
    enabled,
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (all && hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [all, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const shares = useMemo(() => {
    const seen = new Set<string>();
    const out: Share[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const s of page.items) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        out.push(s);
      }
    }
    return out;
  }, [query.data]);
  return {
    query,
    shares,
    hasMore: hasNextPage,
    loadingMore: isFetchingNextPage,
    loadMore: () => void fetchNextPage(),
  };
}
