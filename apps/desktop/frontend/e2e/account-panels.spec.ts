import type { Page } from '@playwright/test';
import { expect, test, uuid, vault, type CloudSeed } from './cloud';

// Settings > Cloud and Settings > Sharing with the components of @memobrain/cloud-features over the
// bindings (ADR-0037 §2): the server's quota level and the space of each vault, the devices with
// the one in use protected, and the shares of the account (create, edit, give access, revoke; a
// manager shares inside the share they manage, ADR-0041 §8). On the web the same panels run on the
// real Go core, which calls the REST mock of web/e2e/cloudMock.ts (the `cloud` fixture).

const TEAM = uuid(1);
const DIARY = uuid(2);
const COMPANY = uuid(9);
const BOB = uuid(0xb0b);
const ADA = uuid(0xada);
const MB = 1024 * 1024;

const seed: CloudSeed = {
  vaults: [vault(TEAM, 'Team', 'shared', 30 * MB), vault(DIARY, 'Diary', 'private', 40 * MB)],
  // 70 % of the quota, above the administrator's warning threshold.
  usage: { used_bytes: 70 * MB, quota_bytes: 100 * MB, level: 'warning' },
  devices: [
    {
      id: uuid(0xd2),
      name: 'Office PC',
      platform: 'windows',
      app_version: '1.1.0',
      last_seen_at: '2026-10-29T10:00:00Z',
      created_at: '2026-02-01T00:00:00Z',
    },
  ],
  directory: { users: [{ id: BOB, username: 'bob', display_name: 'Bob Smith' }] },
};

async function openSettings(page: Page, section: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: section, exact: true }).click();
}

test('storage with the server level, devices with the one in use protected', async ({
  page,
  cloud,
}) => {
  await cloud.openVault(page, seed, { open: TEAM });
  await openSettings(page, 'Cloud');

  await expect(page.getByText('70 MB of 100 MB')).toBeVisible();
  await expect(page.getByTestId('quota-bar')).toHaveAttribute('data-level', 'warn');
  await expect(page.getByText('Your space is running low.')).toBeVisible();
  const byVault = page.getByRole('table', { name: 'Space by vault' });
  await expect(byVault.getByRole('rowheader')).toHaveText(['Diary', 'Team']);

  // The device this client runs on (the mock's computer, the browser the core registered).
  const devices = page.getByRole('table', { name: 'Devices' });
  const current = devices.getByRole('row').filter({ hasText: 'This device' });
  await expect(current).toHaveCount(1);
  await expect(current.getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke Office PC' }).click();
  const confirm = page.getByRole('dialog', { name: 'Revoke this device?' });
  await confirm.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('“Office PC” revoked.')).toBeVisible();
  await expect(devices.getByRole('rowheader', { name: 'Office PC' })).toHaveCount(0);
  if (cloud.rest)
    expect(cloud.rest.state.devices.find((d) => d.name === 'Office PC')?.revoked_at).toBeTruthy();
});

test('create a share of a shared vault, edit it, give access, revoke it', async ({
  page,
  cloud,
}) => {
  await cloud.openVault(page, seed, { open: TEAM });
  await openSettings(page, 'Sharing');

  await page.getByRole('button', { name: 'New share' }).click();
  const create = page.getByRole('dialog', { name: 'New share' });
  // Only the shared vault is offered: a private vault can never be shared (D-02).
  await expect(create.getByLabel('Vault', { exact: true }).locator('option')).toHaveText(['Team']);
  await expect(create).toContainText('Private vaults are end-to-end encrypted');
  await create.getByRole('radio', { name: 'A folder' }).check();
  await create.getByLabel('Folder', { exact: true }).fill('Projects/Alfa');
  await create.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('region', { name: 'Alfa' });
  await expect(share).toContainText('in Team · Projects/Alfa');
  await expect(share).toContainText('Nobody has access yet.');

  // Access: Bob as an editor, found in the directory.
  const search = share.getByRole('form', { name: 'Add people or groups' });
  await search.getByLabel('Name or username').fill('bob');
  await search.getByLabel('With permission').selectOption('editor');
  await search.getByRole('button', { name: 'Search' }).click();
  await search.getByRole('button', { name: 'Add Bob Smith' }).click();
  await expect(share.getByLabel('Permission of bob')).toHaveValue('editor');

  // Name and expiry (PATCH /shares/{id}).
  await share.getByRole('button', { name: 'Edit Alfa' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit “Alfa”' });
  await edit.getByLabel('Name').fill('Alfa project');
  await edit.getByRole('checkbox', { name: 'No expiry' }).uncheck();
  await edit.getByLabel('Expires on').fill('2099-12-31');
  await edit.getByRole('button', { name: 'Save' }).click();
  const renamed = page.getByRole('region', { name: 'Alfa project' });
  await expect(renamed).toContainText('Expires');
  const owned = await cloud.ownedShares(page);
  expect(
    owned.map((s) => [
      s.display_name,
      s.vault_id,
      s.path_prefix,
      Boolean(s.expires_at),
      (s.grants ?? []).map((g) => [g.principal_name, g.permission]),
    ]),
  ).toEqual([['Alfa project', TEAM, 'Projects/Alfa', true, [['bob', 'editor']]]]);

  await renamed.getByRole('button', { name: 'Revoke Alfa project' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke “Alfa project”?' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(page.getByText('“Alfa project” revoked.')).toBeVisible();
  await expect(page.getByText('You have not shared anything yet')).toBeVisible();
  expect(await cloud.ownedShares(page)).toEqual([]);
});

test('a manager shares a subfolder of the folder they manage (ADR-0041 §8)', async ({
  page,
  cloud,
}) => {
  // A folder of ada's vault, managed by the user: the vault is not among the user's cloud vaults.
  await cloud.openVault(
    page,
    {
      ...seed,
      shares: [
        {
          id: uuid(0x5a),
          vault_id: COMPANY,
          vault_name: 'Company',
          resource_type: 'folder',
          path_prefix: 'Projects/Alfa',
          display_name: 'Alfa',
          owner_id: ADA,
          owner_name: 'ada',
          created_at: '2026-10-01T10:00:00Z',
          my_permission: 'manager',
          my_status: 'accepted',
          grants: [],
        },
      ],
    },
    { open: TEAM },
  );
  await openSettings(page, 'Sharing');

  const alfa = page.getByRole('region', { name: 'Alfa' });
  await expect(alfa).toContainText('only its owner can revoke it');
  await alfa.getByRole('button', { name: 'Share inside Alfa' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share inside “Alfa”' });
  await expect(dialog).toContainText('Inside “Alfa” · in Company · Projects/Alfa');
  await dialog.getByLabel('Subfolder', { exact: true }).fill('Drafts');
  await dialog.getByRole('button', { name: 'Share' }).click();

  const drafts = page.getByRole('region', { name: 'Drafts' });
  await expect(drafts).toContainText('in Company · Projects/Alfa/Drafts');
  await expect(drafts.getByRole('button', { name: /Revoke/ })).toHaveCount(0);
  const made = (await cloud.ownedShares(page)).find((s) => s.display_name === 'Drafts');
  expect(made).toMatchObject({
    vault_id: COMPANY,
    path_prefix: 'Projects/Alfa/Drafts',
    owner_name: 'ada',
    my_permission: 'manager',
  });
});
