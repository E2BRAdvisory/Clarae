// The panels of @clarae/cloud-features loaded on demand: Settings > Cloud and Sharing are not
// needed to open a vault, so they stay out of the initial bundle (ADR-0020). A failed download is
// retried once; then the error boundary of the settings section offers a retry. The style sheet
// (workbench.css) is imported by the hosts, statically: a lazy chunk's CSS would not be loaded.
import { Suspense } from 'react';
import type {
  CloudVaultsTableProps,
  DevicesPanelProps,
  InvitationsListProps,
  MountsListProps,
  SharesManagerProps,
  UsagePanelProps,
} from '@clarae/cloud-features';
import { lazyView } from '../ui/lazyView';

const load = () => import('@clarae/cloud-features/panels');

const LazyVaults = lazyView(async () => ({ default: (await load()).CloudVaultsTable }));
const LazyDevices = lazyView(async () => ({ default: (await load()).DevicesPanel }));
const LazyUsage = lazyView(async () => ({ default: (await load()).UsagePanel }));
const LazyShares = lazyView(async () => ({ default: (await load()).SharesManager }));
const LazyInvitations = lazyView(async () => ({ default: (await load()).InvitationsList }));
const LazyMounts = lazyView(async () => ({ default: (await load()).MountsList }));

export function CloudVaultsTable(props: CloudVaultsTableProps) {
  return (
    <Suspense fallback={null}>
      <LazyVaults {...props} />
    </Suspense>
  );
}

export function DevicesPanel(props: DevicesPanelProps) {
  return (
    <Suspense fallback={null}>
      <LazyDevices {...props} />
    </Suspense>
  );
}

export function UsagePanel(props: UsagePanelProps) {
  return (
    <Suspense fallback={null}>
      <LazyUsage {...props} />
    </Suspense>
  );
}

export function SharesManager(props: SharesManagerProps) {
  return (
    <Suspense fallback={null}>
      <LazyShares {...props} />
    </Suspense>
  );
}

export function InvitationsList(props: InvitationsListProps) {
  return (
    <Suspense fallback={null}>
      <LazyInvitations {...props} />
    </Suspense>
  );
}

export function MountsList(props: MountsListProps) {
  return (
    <Suspense fallback={null}>
      <LazyMounts {...props} />
    </Suspense>
  );
}
