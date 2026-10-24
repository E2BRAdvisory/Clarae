import { createContext, useContext, type ReactNode } from 'react';
import type { NodusClient } from '@nodus/api-client';

const ApiContext = createContext<NodusClient | null>(null);

export function ApiProvider({ client, children }: { client: NodusClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): NodusClient {
  const c = useContext(ApiContext);
  if (!c) throw new Error('useApi must be used inside <ApiProvider>');
  return c;
}
