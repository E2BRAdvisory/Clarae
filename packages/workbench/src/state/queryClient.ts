import { QueryClient } from '@tanstack/react-query';

/** Shared so non-React code (actions, event handlers) can invalidate queries. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
