import { expect, test, type Route } from '@playwright/test';
import { ME, mockApi, signedIn } from './support';

// The lifecycle of a cloud vault in the console (ADR-0037 §2, @memobrain/cloud-features): the REST
// API is a small in-memory server here, so each step sees the result of the previous one.

interface Vault {
  id: string;
  owner_id: string;
  name: string;
  kind: string;
  last_seq: number;
  total_bytes: number;
  file_count: number;
  created_at: string;
  deleted_at?: string;
}

function vaultServer() {
  const vaults: Vault[] = [];
  const add = (name: string, kind = 'shared'): Vault => {
    const v: Vault = {
      id: `0198f1c2-aaaa-7bbb-8ccc-${String(vaults.length + 1).padStart(12, '0')}`,
      owner_id: ME,
      name,
      kind,
      last_seq: 0,
      total_bytes: 0,
      file_count: 0,
      created_at: '2026-10-01T10:00:00Z',
    };
    vaults.push(v);
    return v;
  };
  const byId = (route: Route) => {
    const m = /\/vaults\/([^/:]+)/.exec(new URL(route.request().url()).pathname);
    return vaults.find((v) => v.id === m?.[1]) as Vault;
  };
  return { vaults, add, byId };
}

test('create a shared vault, rename it, delete it and restore it', async ({ page }) => {
  await signedIn(page);
  const srv = vaultServer();
  srv.add('Notes');
  const idOf = (i: number) => `0198f1c2-aaaa-7bbb-8ccc-${String(i).padStart(12, '0')}`;
  const routes: Record<string, unknown> = {
    'GET /config/effective': { version: 1, config: {}, locked_keys: [] },
    'GET /shares': [],
    'GET /vaults': (route: Route) => ({
      items: srv.vaults.filter(
        (v) =>
          new URL(route.request().url()).searchParams.get('include_deleted') === 'true' ||
          !v.deleted_at,
      ),
      mounts: [],
    }),
    'POST /vaults': (_route: Route, body: { name: string; kind: string }) =>
      srv.add(body.name, body.kind),
  };
  for (const i of [1, 2]) {
    routes[`PATCH /vaults/${idOf(i)}`] = (route: Route, body: { name: string }) =>
      Object.assign(srv.byId(route), { name: body.name });
    routes[`DELETE /vaults/${idOf(i)}`] = (route: Route) => {
      srv.byId(route).deleted_at = '2026-11-01T09:00:00Z';
      return undefined;
    };
    routes[`POST /vaults/${idOf(i)}:restore`] = (route: Route) => {
      const v = srv.byId(route);
      delete v.deleted_at;
      return v;
    };
  }
  const calls = await mockApi(page, routes);
  await page.goto('/vaults');
  const live = page.getByRole('table', { name: 'My vaults' });
  await expect(live.getByRole('rowheader', { name: 'Notes' })).toBeVisible();

  // Create a shared vault.
  await page.getByRole('button', { name: 'New vault' }).click();
  const create = page.getByRole('dialog', { name: 'New cloud vault' });
  await create.getByLabel('Name').fill('Team');
  await expect(create.getByRole('radio', { name: /Shared/ })).toBeChecked();
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(live.getByRole('rowheader', { name: 'Team' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('“Team” created.');

  // Rename it.
  await page.getByRole('button', { name: 'Rename Team' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename vault' });
  await rename.getByLabel('Name').fill('Team docs');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(live.getByRole('rowheader', { name: 'Team docs' })).toBeVisible();

  // Delete it: the confirmation explains the retention.
  await page.getByRole('button', { name: 'Delete Team docs' }).click();
  const del = page.getByRole('dialog', { name: 'Delete “Team docs”?' });
  await expect(del).toContainText('restore it from “Deleted vaults”');
  await del.getByRole('button', { name: 'Delete' }).click();
  const gone = page.getByRole('table', { name: 'Deleted vaults' });
  await expect(gone.getByRole('rowheader', { name: 'Team docs' })).toBeVisible();
  await expect(live.getByRole('rowheader', { name: 'Team docs' })).toHaveCount(0);

  // Restore it.
  await gone.getByRole('button', { name: 'Restore Team docs' }).click();
  await expect(live.getByRole('rowheader', { name: 'Team docs' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Deleted vaults' })).toHaveCount(0);
  expect(calls).toEqual(
    expect.arrayContaining([
      'POST /vaults',
      `PATCH /vaults/${idOf(2)}`,
      `DELETE /vaults/${idOf(2)}`,
      `POST /vaults/${idOf(2)}:restore`,
    ]),
  );
});

test('a private vault is created in the browser workbench', async ({ page }) => {
  await signedIn(page);
  await mockApi(page, {
    'GET /config/effective': { version: 1, config: {}, locked_keys: [] },
    'GET /shares': [],
    'GET /vaults': { items: [], mounts: [] },
  });
  // The workbench page itself is not under test here: only where the console sends the browser.
  await page.route('**/vaults/new/open**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>workbench</h1>' }),
  );
  await page.goto('/vaults');
  await page.getByRole('button', { name: 'New vault' }).click();
  const create = page.getByRole('dialog', { name: 'New cloud vault' });
  await create.getByLabel('Name').fill('My diary');
  await create.getByRole('radio', { name: /Private/ }).check();
  await expect(create).toContainText('it can never be shared');
  await create.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'workbench' })).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toBe('/vaults/new/open');
  expect(url.searchParams.get('kind')).toBe('private');
  expect(url.searchParams.get('name')).toBe('My diary');
});
