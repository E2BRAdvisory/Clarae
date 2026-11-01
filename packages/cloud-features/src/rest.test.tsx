import { createClient } from '@memobrain/api-client';
import { describe, expect, it } from 'vitest';
import { RestCloudPort, type RestCloudPortOptions } from './rest';
import { cloudVaultsTableSuite, fakeVaultApi, type SeedVault } from './testing';

function restPort(
  seed: SeedVault[],
  options: RestCloudPortOptions = { createPrivate: true, deletedRetentionDays: 30 },
) {
  const fake = fakeVaultApi(seed);
  const api = createClient({ baseUrl: 'http://cloud.test/api/v1', fetch: fake.fetch });
  return { port: new RestCloudPort(api, options), fake };
}

cloudVaultsTableSuite({ name: 'RestCloudPort', setup: (seed) => restPort(seed).port });

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
    });
  });
});
