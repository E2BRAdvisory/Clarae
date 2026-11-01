import { useQuery } from '@tanstack/react-query';
import { api } from '../app/api';

export const sharingKeys = {
  invitations: ['shares', 'invitations'] as const,
  mounts: ['shares', 'mounts'] as const,
  vault: (vaultId: string) => ['shares', 'vault', vaultId] as const,
};

/** Shares waiting for the user's answer. Fails quietly (signed out, offline) as an empty list. */
export function useInvitations(enabled = true) {
  return useQuery({
    queryKey: sharingKeys.invitations,
    queryFn: () => api.sharing.invitations().catch(() => []),
    enabled,
    staleTime: 30_000,
  });
}

/** Accepted shares and the state of their folders on this device. */
export function useMounts(enabled = true) {
  return useQuery({
    queryKey: sharingKeys.mounts,
    queryFn: () => api.sharing.mounts().catch(() => []),
    enabled,
    staleTime: 30_000,
  });
}
