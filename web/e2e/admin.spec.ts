import { expect, test } from '@playwright/test';
import { mockApi, signedIn } from './support';

const MB = 1024 * 1024;
const overview = {
  default_quota_bytes: 100 * MB,
  total_used_bytes: 300 * MB,
  user_count: 3,
  users_over_warn: 1,
  users_over_critical: 1,
  top_consumers: [
    { user_id: 'u1', username: 'alice', used_bytes: 96 * MB, quota_bytes: 100 * MB },
    { user_id: 'u2', username: 'bob', used_bytes: 10 * MB, quota_bytes: -1 },
  ],
  trend: [
    { day: '2026-03-01', total_bytes: 100 * MB },
    { day: '2026-03-02', total_bytes: 300 * MB },
  ],
};

const adminUser = (id: string, username: string) => ({
  id,
  username,
  email: `${username}@example.com`,
  display_name: username,
  role: 'user',
  status: 'active',
  quota_bytes: 100 * MB,
  used_bytes: MB,
  created_at: '2026-01-01T00:00:00Z',
});

test('an administrator opens the console and sees the storage dashboard', async ({ page }) => {
  await signedIn(page, ['clarae-admin']);
  await mockApi(page, { 'GET /admin/storage/overview': overview });
  await page.goto('/usage');
  await page.getByRole('link', { name: 'Administration' }).click();
  await expect(page).toHaveURL(/\/admin\/storage$/);
  await expect(page.getByRole('navigation', { name: 'Administration sections' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top consumers' })).toBeVisible();
  await expect(page.getByTestId('trend-chart')).toBeVisible();
  const bars = page.getByTestId('quota-bar');
  await expect(bars.first()).toHaveAttribute('data-level', 'critical');
  await page.getByRole('link', { name: 'Users', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test('regular users do not get the administration entry or the console', async ({ page }) => {
  await signedIn(page, []);
  await mockApi(page, { 'GET /me/usage': { used_bytes: 1, quota_bytes: 100, level: 'ok' } });
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Storage used' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByText('You do not have access to this page.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Administration sections' })).toHaveCount(0);
});

test('an administrator creates a user', async ({ page }) => {
  await signedIn(page, ['clarae-admin']);
  let users = [adminUser('u1', 'alice')];
  let created: unknown;
  await mockApi(page, {
    'GET /admin/groups': { items: [] },
    'GET /admin/users': () => ({ items: users, total: users.length }),
    'POST /admin/users': (_route: unknown, body: unknown) => {
      created = body;
      users = [...users, adminUser('u2', (body as { username: string }).username)];
      return users[users.length - 1];
    },
  });
  await page.goto('/admin/users');
  await expect(page.getByRole('link', { name: 'alice' })).toBeVisible();
  await page.getByRole('button', { name: 'Create user' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a user' });
  await dialog.getByLabel('Username').fill('carol');
  await dialog.getByLabel('E-mail').fill('carol@example.com');
  await dialog.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByText('User carol created.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'carol' })).toBeVisible();
  expect(created).toEqual({ username: 'carol', email: 'carol@example.com', role: 'user' });
});

test('downloading a shared vault as ZIP triggers a browser download', async ({ page }) => {
  await signedIn(page, []);
  await mockApi(page, {
    'GET /vaults': {
      items: [
        {
          id: 's1',
          owner_id: 'u1',
          name: 'Notes',
          kind: 'shared',
          last_seq: 1,
          total_bytes: 10,
          file_count: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      mounts: [],
    },
  });
  // registered last: takes precedence over the generic JSON mock for this binary response
  await page.route('**/api/v1/vaults/s1/export.zip', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/zip',
      headers: { 'Content-Disposition': 'attachment; filename="notes-export.zip"' },
      body: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'),
    }),
  );
  await page.goto('/vaults');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download ZIP: Notes' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('notes-export.zip');
  await expect(page.getByText('The download of notes-export.zip started.')).toBeVisible();
});
