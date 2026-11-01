// The panels of @memobrain/cloud-features loaded on demand: Settings > Cloud and Sharing are not
// needed to open a vault, so they stay out of the initial bundle (ADR-0020). The style sheet
// (workbench.css) is imported by the hosts, statically: a lazy chunk's CSS would not be loaded.
import { Suspense, lazy } from 'react';
import type {
  CloudVaultsTableProps,
  DevicesPanelProps,
  InvitationsListProps,
  SharesManagerProps,
  UsagePanelProps,
} from '@memobrain/cloud-features';

const load = () => import('@memobrain/cloud-features/panels');

const LazyVaults = lazy(async () => ({ default: (await load()).CloudVaultsTable }));
const LazyDevices = lazy(async () => ({ default: (await load()).DevicesPanel }));
const LazyUsage = lazy(async () => ({ default: (await load()).UsagePanel }));
const LazyShares = lazy(async () => ({ default: (await load()).SharesManager }));
const LazyInvitations = lazy(async () => ({ default: (await load()).InvitationsList }));

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
