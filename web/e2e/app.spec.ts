import { expect, test, type Route } from '@playwright/test';
import { BOB, ME, mockApi, signedIn } from './support';

test('anonymous visitors are sent to sign in and the target path is remembered', async ({
  page,
}) => {
  await page.route('**/e2e-signin**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Identity provider</h1>' }),
  );
  await mockApi(page, {});
  await page.goto('/vaults');
  await expect(page.getByRole('heading', { name: 'Identity provider' })).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toBe('/e2e-signin');
  expect(url.searchParams.get('returnTo')).toBe('/vaults');
});

test('the usage page shows the quota bar and its warning level', async ({ page }) => {
  await signedIn(page);
  await mockApi(page, { 'GET /me/usage': { used_bytes: 96, quota_bytes: 100, level: 'critical' } });
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Storage used' })).toBeVisible();
  await expect(page.getByTestId('quota-bar')).toHaveAttribute('data-level', 'critical');
  await expect(page.getByRole('progressbar', { name: 'Storage used' })).toHaveAttribute(
    'value',
    '96',
  );
  await expect(page.getByText('96 B of 100 B')).toBeVisible();
});

test('the admin area is hidden from regular users', async ({ page }) => {
  await signedIn(page);
  await mockApi(page, {});
  await page.goto('/admin');
  await expect(page.getByText('You do not have access to this page.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);
});

const common = {
  vault_id: 'v1',
  vault_name: 'Docs',
  resource_type: 'folder',
  created_at: '2026-01-01T00:00:00Z',
};

test('accepting an invitation moves it to the accepted shares', async ({ page }) => {
  await signedIn(page);
  let status: 'pending' | 'accepted' = 'pending';
  const calls = await mockApi(page, {
    'GET /me': { id: ME },
    'GET /shares': (route: Route) => ({
      items:
        new URL(route.request().url()).searchParams.get('scope') === 'owned'
          ? []
          : [
              {
                ...common,
                id: 's1',
                display_name: 'Budget',
                owner_id: BOB,
                owner_name: 'Bob',
                my_permission: 'editor',
                my_status: status,
              },
            ],
    }),
    'POST /shares/s1:accept': () => {
      status = 'accepted';
      return {
        ...common,
        id: 's1',
        display_name: 'Budget',
        owner_id: BOB,
        owner_name: 'Bob',
        my_permission: 'editor',
        my_status: status,
      };
    },
  });
  await page.goto('/shares');
  await page.getByRole('button', { name: 'Accept Budget' }).click();
  await expect(page.getByText('Invitation to “Budget” accepted.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accepted shares' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept Budget' })).toHaveCount(0);
  expect(calls).toContain('POST /shares/s1:accept');
});

test('revoking a share asks for confirmation and removes it', async ({ page }) => {
  await signedIn(page);
  let owned = [
    {
      ...common,
      id: 's2',
      display_name: 'Project X',
      owner_id: ME,
      owner_name: 'Alice',
      grants: [],
    },
  ];
  const calls = await mockApi(page, {
    'GET /me': { id: ME },
    'GET /shares': (route: Route) => ({
      items: new URL(route.request().url()).searchParams.get('scope') === 'owned' ? owned : [],
    }),
    'DELETE /shares/s2': () => {
      owned = [];
      return undefined;
    },
  });
  await page.goto('/shares');
  await page.getByRole('button', { name: 'Revoke Project X' }).click();
  await expect(page.getByRole('dialog', { name: 'Revoke “Project X”?' })).toBeVisible();
  expect(calls).not.toContain('DELETE /shares/s2');
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('“Project X” revoked.')).toBeVisible();
  await expect(page.getByText('You have not shared anything yet')).toBeVisible();
  expect(calls).toContain('DELETE /shares/s2');
});
