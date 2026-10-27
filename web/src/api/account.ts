import { useMutation } from '@tanstack/react-query';
import { ApiError, type MemobrainClient, type Schemas } from '@memobrain/api-client';
import { useApi } from './context';

/** Fetches the account export with the bearer token of the client (a plain link could not send it). */
export async function fetchAccountExport(api: MemobrainClient): Promise<Blob> {
  const { data, error, response } = await api.GET('/me/export', { parseAs: 'blob' });
  if (!response.ok) {
    const problem = error as Schemas['Problem'] | undefined;
    throw new ApiError(response.status, problem, `${response.status} ${response.statusText}`);
  }
  return data as unknown as Blob;
}

export function useExportMyData() {
  const api = useApi();
  return useMutation({ mutationFn: () => fetchAccountExport(api) });
}

export function useDeleteMyAccount() {
  const api = useApi();
  return useMutation({
    mutationFn: async (body: Schemas['AccountDeletionRequest']) => {
      const { error, response } = await api.DELETE('/me', { body });
      if (!response.ok) {
        const problem = error as Schemas['Problem'] | undefined;
        throw new ApiError(response.status, problem, `${response.status} ${response.statusText}`);
      }
    },
  });
}
