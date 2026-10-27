import { createContext, useContext, type ReactNode } from 'react';
import type { MemobrainClient } from '@memobrain/api-client';

const ApiContext = createContext<MemobrainClient | null>(null);

export function ApiProvider({
  client,
  children,
}: {
  client: MemobrainClient;
  children: ReactNode;
}) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): MemobrainClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error('useApi must be used inside <ApiProvider>');
  return c;
}
