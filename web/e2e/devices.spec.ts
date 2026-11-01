import { expect, test } from '@playwright/test';
import { ME, mockApi, signedIn } from './support';

// Devices and storage in the console (ADR-0037 §2, DevicesPanel and UsagePanel of
// @memobrain/cloud-features over REST): the API is a small in-memory server, so each step sees the
// result of the previous one.

const MB = 1024 * 1024;

test('revoke a device after a confirmation; a revoked one cannot be revoked again', async ({
  page,
}) => {
  await signedIn(page);
  const devices: Record<string, unknown>[] = [
    {
      id: 'd1',
      name: 'Laptop',
      platform: 'macos',
      app_version: '1.2.0',
      created_at: '2026-01-01T00:00:00Z',
      last_seen_at: '2026-10-30T10:00:00Z',
    },
    { id: 'd2', name: 'Firefox', platform: 'web', created_at: '2026-03-01T00:00:00Z' },
  ];
  const calls = await mockApi(page, {
    'GET /me/devices': () => ({ items: devices }),
    'DELETE /me/devices/d1': () => {
      devices[0]!['revoked_at'] = '2026-11-01T10:00:00Z';
      return undefined;
    },
  });
  await page.goto('/devices');
  const table = page.getByRole('table', { name: 'Devices' });
  await expect(table.getByRole('row', { name: /Firefox/ })).toContainText('Browser');
  await page.getByRole('button', { name: 'Revoke Laptop' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke this device?' });
  await expect(dialog).toContainText('“Laptop” stops synchronizing');
  expect(calls).not.toContain('DELETE /me/devices/d1');
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('“Laptop” revoked.')).toBeVisible();
  await expect(table.getByRole('row', { name: /Laptop/ })).toContainText('Revoked');
  await expect(page.getByRole('button', { name: 'Revoke Laptop' })).toHaveCount(0);
  expect(calls).toContain('DELETE /me/devices/d1');
});

test('the storage page shows the level of the server and the space of each vault', async ({
  page,
}) => {
  await signedIn(page);
  const vault = (id: string, name: string, kind: string, bytes: number) => ({
    id,
    owner_id: ME,
    name,
    kind,
    last_seq: 1,
    total_bytes: bytes,
    file_count: 2,
    created_at: '2026-01-01T00:00:00Z',
  });
  await mockApi(page, {
    // 70 %: the administrator's warning threshold is lower than the default 80 %.
    'GET /me/usage': { used_bytes: 70 * MB, quota_bytes: 100 * MB, level: 'warning' },
    'GET /vaults': {
      items: [vault('v1', 'Notes', 'shared', 20 * MB), vault('v2', 'Diary', 'private', 50 * MB)],
      mounts: [],
    },
  });
  await page.goto('/usage');
  await expect(page.getByTestId('quota-bar')).toHaveAttribute('data-level', 'warn');
  await expect(page.getByText('70 MB of 100 MB')).toBeVisible();
  await expect(page.getByText('Your space is running low.')).toBeVisible();
  const byVault = page.getByRole('table', { name: 'Space by vault' });
  await expect(byVault.getByRole('rowheader')).toHaveText(['Diary', 'Notes']);
  await expect(byVault.getByRole('row', { name: /Diary/ })).toContainText('71%');
});
