import { createClient } from '@memobrain/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RestCloudPort, type RestCloudPortOptions } from './rest';
import { InvitationsList } from './sharing/InvitationsList';
import {
  cloudAccountSuite,
  cloudVaultsTableSuite,
  fakeCloudApi,
  fakeVaultApi,
  type CloudSeed,
  type SeedVault,
} from './testing';

function restPort(
  seed: SeedVault[],
  options: RestCloudPortOptions = { createPrivate: true, deletedRetentionDays: 30 },
) {
  const fake = fakeVaultApi(seed);
  const api = createClient({ baseUrl: 'http://cloud.test/api/v1', fetch: fake.fetch });
  return { port: new RestCloudPort(api, options), fake };
}

cloudVaultsTableSuite({ name: 'RestCloudPort', setup: (seed) => restPort(seed).port });

function restCloud(seed: CloudSeed) {
  const fake = fakeCloudApi(seed);
  const api = createClient({ baseUrl: 'http://cloud.test/api/v1', fetch: fake.fetch });
  return { port: new RestCloudPort(api, { createPrivate: true }), fake };
}

cloudAccountSuite({
  name: 'RestCloudPort',
  knowsCurrentDevice: false,
  setup: (seed) => restCloud(seed).port,
});

describe('RestCloudPort', () => {
  it('calls the documented operations', async () => {
    const { port, fake } = restPort([{ name: 'Notes', kind: 'shared' }]);
    const [v] = await port.listVaults();
    await port.renameVault(v!.id, 'Journal');
    await port.deleteVault(v!.id);
    expect((await port.listDeletedVaults()).map((x) => x.name)).toEqual(['Journal']);
    await port.restoreVault(v!.id);
    await port.createVault('Team', 'shared');
    expect(fake.calls).toEqual([
      'GET /vaults',
      `PATCH /vaults/${v!.id}`,
      `DELETE /vaults/${v!.id}`,
      'GET /vaults',
      `POST /vaults/${v!.id}:restore`,
      'POST /vaults',
    ]);
  });

  it('rejects with the API code', async () => {
    const { port } = restPort([
      { name: 'Notes', kind: 'shared' },
      { name: 'Work', kind: 'shared' },
    ]);
    const [v] = await port.listVaults();
    await expect(port.renameVault(v!.id, 'Work')).rejects.toMatchObject({ code: 'NAME_IN_USE' });
  });

  it('without the retention days and the workbench, says so in its capabilities', () => {
    const { port } = restPort([], {});
    expect(port.capabilities).toEqual({
      createShared: true,
      createPrivate: false,
      keepsLocalCopy: false,
      myGroups: true,
    });
  });

  it('calls the documented account operations', async () => {
    const { port, fake } = restCloud({
      vaults: [{ name: 'Team', kind: 'shared' }],
      devices: [{ id: 'd1', name: 'PC', platform: 'linux', created_at: '2026-01-01T00:00:00Z' }],
      users: [{ id: 'u1', username: 'bob' }],
      groups: [{ id: 'g1', name: 'team' }],
      features: { sharing: false, drawings: true },
    });
    const [v] = await port.listVaults();
    await port.listDevices();
    await port.revokeDevice('d1');
    await port.getUsage();
    const s = await port.createShare({
      vault_id: v!.id,
      display_name: 'Docs',
      path_prefix: 'Docs',
    });
    expect(s).toMatchObject({ resource_type: 'folder', path_prefix: 'Docs' });
    await port.updateShare(s.id, { display_name: 'Guide' });
    await port.putGrant(s.id, 'user', 'u1', 'viewer');
    await port.deleteGrant(s.id, 'user', 'u1');
    await port.revokeShare(s.id);
    await port.listShares('received');
    expect(await port.searchDirectory('user', 'bo')).toEqual([
      { type: 'user', id: 'u1', name: 'bob', detail: 'bob' },
    ]);
    await port.searchDirectory('group', 'te');
    await port.listMyGroups();
    expect(await port.getFeatures()).toEqual({ sharing: false, drawings: true });
    expect(fake.calls).toEqual([
      'GET /vaults',
      'GET /me/devices',
      'DELETE /me/devices/d1',
      'GET /me/usage',
      'POST /shares',
      `PATCH /shares/${s.id}`,
      `PUT /shares/${s.id}/grants/user/u1`,
      `DELETE /shares/${s.id}/grants/user/u1`,
      `DELETE /shares/${s.id}`,
      'GET /shares',
      'GET /directory/users',
      'GET /directory/groups',
      'GET /me/groups',
      'GET /config/effective',
    ]);
  });

  it('answers invitations with the documented operations', async () => {
    const { port, fake } = restCloud({
      received: [
        {
          id: 'i1',
          vault_id: 'v',
          vault_name: 'Company',
          resource_type: 'vault',
          display_name: 'Budget',
          owner_id: 'o',
          owner_name: 'ada',
          created_at: '2026-10-01T10:00:00Z',
          my_status: 'pending',
        },
      ],
    });
    await port.acceptInvitation('i1');
    expect(await port.listMounts()).toMatchObject([{ share_id: 'i1', display_name: 'Budget' }]);
    await port.declineInvitation('i1');
    expect(await port.listMounts()).toEqual([]);
    expect(fake.calls).toEqual([
      'POST /shares/i1:accept',
      'GET /shared-with-me',
      'POST /shares/i1:decline',
      'GET /shared-with-me',
    ]);
  });

  it('does not ask again for a configuration that cannot be read each time a list mounts', async () => {
    const fake = fakeCloudApi({});
    let configCalls = 0;
    const api = createClient({
      baseUrl: 'http://cloud.test/api/v1',
      fetch: (req: Request) => {
        if (new URL(req.url).pathname.endsWith('/config/effective')) {
          configCalls++;
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        return fake.fetch(req);
      },
    });
    const port = new RestCloudPort(api);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <InvitationsList port={port} lang="en" />
      </QueryClientProvider>,
    );
    // The flag falls back to its default (sharing on) and the lists load.
    expect(await screen.findByText('No invitations.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(configCalls).toBe(1);
  });
});
