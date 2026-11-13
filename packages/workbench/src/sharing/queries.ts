import { cloudKeys, useSharePages } from '@clarae/cloud-features';
import type { Share } from '@clarae/cloud-features/port';
import { CoreCloudPort } from '../cloud/CoreCloudPort';

/** The workbench's sharing calls go through its CloudPort (ADR-0045 §7, enforced by ESLint). */
const port = new CoreCloudPort();

export const sharingKeys = {
  /**
   * The shares received, in the cache of @clarae/cloud-features: the status bar's count and
   * InvitationsList read the same entry, so answering an invitation updates both.
   */
  received: cloudKeys.sharesOf(port, 'received'),
  /** The list of MountsList over CoreCloudPort: the actions refresh it. */
  mounts: cloudKeys.mounts(port),
  vault: (vaultId: string) => ['shares', 'vault', vaultId] as const,
};

const pending = (all: Share[]) => all.filter((s) => (s.my_status ?? 'pending') === 'pending');

/**
 * Shares waiting for the user's answer (none while it cannot be read: signed out, offline). It
 * reads every page of the received shares through the same paged cache entry as InvitationsList
 * (useSharePages), so the count and the list never disagree.
 */
export function useInvitations(enabled = true) {
  const { shares } = useSharePages(port, 'received', { enabled, all: true });
  return { data: pending(shares) };
}
