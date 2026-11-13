import { createContext, useContext, type ReactNode } from 'react';
import type { ClaraeClient } from '@clarae/api-client';

const ApiContext = createContext<ClaraeClient | null>(null);

export function ApiProvider({ client, children }: { client: ClaraeClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ClaraeClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error('useApi must be used inside <ApiProvider>');
  return c;
}
