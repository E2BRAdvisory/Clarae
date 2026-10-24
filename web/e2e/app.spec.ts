import { expect, test, type Page, type Route } from '@playwright/test';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

type Handler = (route: Route, body: unknown) => unknown;

/** Mocks /api/v1/** by "METHOD /path" (query string ignored). Anything else is a 404 problem. */
async function mockApi(page: Page, routes: Record<string, unknown>) {
  const calls: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname.replace(/^\/api\/v1/, '')}`;
    calls.push(key);
    const entry = routes[key];
    if (entry === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          code: 'NOT_FOUND',
        }),
      });
      return;
    }
    const body = req.postData() ? (JSON.parse(req.postData() as string) as unknown) : undefined;
    const out = typeof entry === 'function' ? (entry as Handler)(route, body) : entry;
    if (out === undefined) await route.fulfill({ status: 204 });
    else
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(out),
      });
  });
  return calls;
}

async function signedIn(page: Page, roles: string[] = []) {
  await page.addInitScript(
    (user) => {
      window.sessionStorage.setItem('nodus.e2e.user', JSON.stringify(user));
    },
    { name: 'Alice', roles },
  );
}

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
    'GET /shares': (route: Route) =>
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
  await page.getByRole('button', { name: 'Accept: Budget' }).click();
  await expect(page.getByText('Invitation accepted.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accepted shares' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept: Budget' })).toHaveCount(0);
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
    'GET /shares': (route: Route) =>
      new URL(route.request().url()).searchParams.get('scope') === 'owned' ? owned : [],
    'DELETE /shares/s2': () => {
      owned = [];
      return undefined;
    },
  });
  await page.goto('/shares');
  await page.getByRole('button', { name: 'Revoke share: Project X' }).click();
  await expect(page.getByRole('dialog', { name: 'Revoke this share?' })).toBeVisible();
  expect(calls).not.toContain('DELETE /shares/s2');
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke share' }).click();
  await expect(page.getByText('Share revoked.')).toBeVisible();
  await expect(page.getByText('You have not shared anything yet')).toBeVisible();
  expect(calls).toContain('DELETE /shares/s2');
});
