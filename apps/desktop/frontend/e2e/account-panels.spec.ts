import type { Page } from '@playwright/test';
import { expect, openVault, skipOnWeb, test } from './support';

// Settings > Cloud and Settings > Sharing with the components of @memobrain/cloud-features over the
// bindings (ADR-0037 §2): the server's quota level and the space of each vault, the devices with
// the one in use protected, and the shares of the account (create, edit, give access, revoke).

skipOnWeb(
  'devices',
  'the spec seeds the devices, the usage and the shares of the Wails mock (window.__mock); a vault of this browser has no cloud: the console e2e (web/e2e/devices.spec.ts, shares.spec.ts) runs the same components over REST',
);

interface MockWindow {
  __mock: {
    sync: {
      cloudVaults: Record<string, unknown>[];
      devices: Record<string, unknown>[];
      usage: Record<string, unknown>;
    };
    sharing: {
      owned: { displayName: string; expiresAt: string; grants: { principalName: string }[] }[];
      directory: Record<string, unknown>[];
      revoked: string[];
    };
  };
}

async function signIn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Cloud', exact: true }).click();
  await page.getByLabel('Server address').fill('https://memobrain.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
}

async function seed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    const vault = (id: string, name: string, kind: string, bytes: number) => ({
      id,
      ownerId: 'user-1',
      name,
      kind,
      totalBytes: bytes,
      fileCount: 3,
      lastSeq: 1,
      createdAt: '2026-10-01T10:00:00Z',
    });
    w.__mock.sync.cloudVaults.push(
      vault('cloud-1', 'Team', 'shared', 30 * 1024 * 1024),
      vault('cloud-2', 'Diary', 'private', 40 * 1024 * 1024),
    );
    // 70 % of the quota, above the administrator's warning threshold.
    w.__mock.sync.usage = {
      usedBytes: 70 * 1024 * 1024,
      quotaBytes: 100 * 1024 * 1024,
      level: 'warning',
    };
    w.__mock.sync.devices.push({
      id: 'dev-2',
      name: 'Office PC',
      platform: 'windows',
      appVersion: '1.1.0',
      lastSeenAt: '2026-10-29T10:00:00Z',
      createdAt: '2026-02-01T00:00:00Z',
      revokedAt: '',
      current: false,
    });
    w.__mock.sharing.directory.push({
      type: 'user',
      id: 'u-bob',
      name: 'bob',
      label: 'Bob Smith (bob)',
    });
  });
}

/** Another section and back: the panels fetch again what the test seeded. */
async function reopen(page: Page, section: string): Promise<void> {
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: section, exact: true }).click();
}

test('storage with the server level, devices with the one in use protected', async ({ page }) => {
  await openVault(page);
  await signIn(page);
  await seed(page);
  await reopen(page, 'Cloud');

  await expect(page.getByText('70 MB of 100 MB')).toBeVisible();
  await expect(page.getByTestId('quota-bar')).toHaveAttribute('data-level', 'warn');
  await expect(page.getByText('Your space is running low.')).toBeVisible();
  const byVault = page.getByRole('table', { name: 'Space by vault' });
  await expect(byVault.getByRole('rowheader')).toHaveText(['Diary', 'Team']);

  const devices = page.getByRole('table', { name: 'Devices' });
  const current = devices.getByRole('row', { name: /This computer/ });
  await expect(current.getByText('This device')).toBeVisible();
  await expect(current.getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke Office PC' }).click();
  const confirm = page.getByRole('dialog', { name: 'Revoke this device?' });
  await confirm.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('“Office PC” revoked.')).toBeVisible();
  await expect(devices.getByRole('rowheader', { name: 'Office PC' })).toHaveCount(0);
});

test('create a share of a shared vault, edit it, give access, revoke it', async ({ page }) => {
  await openVault(page);
  await signIn(page);
  await seed(page);
  await page.getByRole('button', { name: 'Sharing', exact: true }).click();

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
  const owned = await page.evaluate(() => (window as unknown as MockWindow).__mock.sharing.owned);
  expect(
    owned.map((s) => [s.displayName, s.expiresAt !== '', s.grants.map((g) => g.principalName)]),
  ).toEqual([['Alfa project', true, ['bob']]]);

  await renamed.getByRole('button', { name: 'Revoke Alfa project' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke “Alfa project”?' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(page.getByText('“Alfa project” revoked.')).toBeVisible();
  await expect(page.getByText('You have not shared anything yet')).toBeVisible();
});
