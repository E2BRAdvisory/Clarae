// The console's CloudPort (ADR-0037 §2): the vault, device, usage and sharing pages are the
// components of @clarae/cloud-features over the REST API.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RestCloudPort, useFeature } from '@clarae/cloud-features';
import { useAuth } from '../auth/AuthProvider';
import { thisBrowserDevice } from '../workbench/device';
import { useApi } from './context';
import { useMe, useWorkbenchAllowed } from './queries';

/** One RestCloudPort per client; a private vault is created in the workbench, when allowed. */
export function useCloudPort(): RestCloudPort {
  const api = useApi();
  const canOpen = useWorkbenchAllowed();
  return useMemo(() => new RestCloudPort(api, { createPrivate: canOpen }), [api, canOpen]);
}

/** Whether the administrator allows sharing (feature `sharing`, on by default). */
export function useSharingAllowed(): boolean {
  return useFeature(useCloudPort(), 'sharing');
}

/**
 * The id of the device this browser registered as for the signed-in account (the browser workbench
 * keeps it in IndexedDB, ADR-0029), so the Devices page marks it and keeps it from being revoked.
 */
export function useThisBrowserDeviceId(): string | undefined {
  const userId = useMe().data?.id;
  const subject = useAuth().user?.sub;
  const q = useQuery({
    queryKey: ['this-browser-device', userId, subject],
    queryFn: async () => (userId && subject ? await thisBrowserDevice(userId, subject) : null),
    enabled: Boolean(userId && subject),
    staleTime: 60_000,
  });
  return q.data ?? undefined;
}
