import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cloudAccountSuite,
  cloudVaultsTableSuite,
  seedVaults,
  type CloudSeed,
} from '@memobrain/cloud-features/testing';
import type { Share } from '@memobrain/cloud-features';
import { api, type ShareInfo } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { CloudSection } from '../settings/CloudSection';
import { configurePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { CoreCloudPort } from './CoreCloudPort';

/** A Wails mock signed in to a cloud holding these vaults (the API seed, as binding DTOs). */
async function signedInMock(seed: Parameters<typeof seedVaults>[0]): Promise<WailsMock> {
  const mock = installWailsMock();
  await api.auth.login('https://memobrain.test');
  mock.sync.cloudVaults = seedVaults(seed).map((v) => ({
    id: v.id,
    ownerId: v.owner_id,
    name: v.name,
    kind: v.kind,
    totalBytes: v.total_bytes,
    fileCount: v.file_count,
    lastSeq: v.last_seq,
    createdAt: v.created_at,
    ...(v.deleted_at ? { deletedAt: v.deleted_at } : {}),
  }));
  return mock;
}

// The same suite as RestCloudPort's (packages/cloud-features/src/rest.test.tsx), on the bindings.
cloudVaultsTableSuite({
  name: 'CoreCloudPort',
  setup: async (seed) => {
    await signedInMock(seed);
    return new CoreCloudPort();
  },
});

/** An API share as the core's DTO. */
function shareInfo(s: Share): ShareInfo {
  return {
    id: s.id,
    vaultId: s.vault_id,
    vaultName: s.vault_name,
    resourceType: s.resource_type,
    pathPrefix: s.path_prefix ?? '',
    displayName: s.display_name,
    ownerId: s.owner_id,
    ownerName: s.owner_name,
    createdAt: s.created_at,
    expiresAt: s.expires_at ?? '',
    myPermission: s.my_permission ?? '',
    myStatus: s.my_status ?? '',
    grants: (s.grants ?? []).map((g) => ({
      principalType: g.principal_type,
      principalId: g.principal_id,
      principalName: g.principal_name,
      permission: g.permission,
      status: g.status,
    })),
  };
}

/** The account seed of the shared suite behind the Wails mock. */
async function accountMock(seed: CloudSeed): Promise<WailsMock> {
  const mock = await signedInMock(seed.vaults ?? []);
  mock.sync.devices = (seed.devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    appVersion: d.app_version ?? '',
    lastSeenAt: d.last_seen_at ?? null,
    createdAt: d.created_at,
    revokedAt: d.revoked_at ?? '',
    current: Boolean(d.current),
  }));
  if (seed.usage)
    mock.sync.usage = {
      usedBytes: seed.usage.used_bytes,
      quotaBytes: seed.usage.quota_bytes,
      level: seed.usage.level,
    };
  mock.sharing.owned = (seed.owned ?? []).map(shareInfo);
  const received = (seed.received ?? []).map(shareInfo);
  mock.sharing.invitations = received.filter((s) => s.myStatus === 'pending');
  mock.sharing.received = received.filter((s) => s.myStatus !== 'pending');
  mock.sharing.directory = [
    ...(seed.users ?? []).map((u) => ({
      type: 'user' as const,
      id: u.id,
      name: u.username,
      label: u.display_name ? `${u.display_name} (${u.username})` : u.username,
      displayName: u.display_name ?? '',
      description: '',
    })),
    ...(seed.groups ?? []).map((g) => ({
      type: 'group' as const,
      id: g.id,
      name: g.name,
      label: g.name,
      displayName: '',
      description: g.description ?? '',
    })),
  ];
  if (seed.features) mock.config = { ...mock.config, features: seed.features };
  return mock;
}

cloudAccountSuite({
  name: 'CoreCloudPort',
  knowsCurrentDevice: true,
  setup: async (seed) => {
    await accountMock(seed);
    return new CoreCloudPort();
  },
});

describe('Settings > Cloud vaults (desktop)', () => {
  const wrap = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CloudSection />
      </QueryClientProvider>,
    );

  async function openLinked(mock: WailsMock) {
    const info = await api.vault.open('/vaults/Notes');
    useAppStore.getState().setVault(info);
    useAppStore.getState().setAuth(await api.auth.status());
    await api.sync.linkExisting(info.id, mock.sync.cloudVaults[0]!.id);
    await useSync.getState().refresh(info.id);
    return info;
  }

  it('deleting the vault linked here disconnects it and keeps its files', async () => {
    initI18n('en');
    configurePlatform({ kind: 'desktop' });
    const mock = await signedInMock([{ name: 'Notes', kind: 'shared' }]);
    const info = await openLinked(mock);
    mock.vaults.get(info.id)?.files.set('Plan.md', '# keep me');
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Notes' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Notes”?' });
    expect(dialog).toHaveTextContent('The copy on this device stays where it is');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await screen.findByRole('table', { name: 'Deleted vaults' });
    await waitFor(async () => expect((await api.sync.info(info.id)).linked).toBe(false));
    expect(mock.vaults.get(info.id)?.files.get('Plan.md')).toBe('# keep me');
  });

  it('renaming shows the new name in the link of the vault open here', async () => {
    initI18n('en');
    configurePlatform({ kind: 'desktop' });
    const mock = await signedInMock([{ name: 'Notes', kind: 'shared' }]);
    const info = await openLinked(mock);
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Notes' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename vault' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Journal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByRole('rowheader', { name: 'Journal' });
    expect((await api.sync.info(info.id)).name).toBe('Journal');
    expect(useAppStore.getState().vault?.name).toBe(info.name); // the folder keeps its name
  });

  it('on the web, the vault open in the page cannot be deleted from it', async () => {
    initI18n('en');
    configurePlatform({ kind: 'web' });
    try {
      const mock = await signedInMock([
        { name: 'Notes', kind: 'shared' },
        { name: 'Work', kind: 'shared' },
      ]);
      await openLinked(mock);
      wrap();
      expect(await screen.findByRole('button', { name: 'Delete Notes' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete Work' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'New vault' })).not.toBeInTheDocument();
    } finally {
      configurePlatform({ kind: 'desktop' });
    }
  });

  it('"New vault" opens the connect wizard for an unlinked folder', async () => {
    initI18n('en');
    configurePlatform({ kind: 'desktop' });
    await signedInMock([]);
    const info = await api.vault.open('/vaults/Fresh');
    useAppStore.getState().setVault(info);
    useAppStore.getState().setAuth(await api.auth.status());
    useAppStore.getState().openSettings('cloud');
    useSync.setState({ info: {}, wizardOpen: false });
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: 'New vault' }));
    expect(useSync.getState().wizardOpen).toBe(true);
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });
});
