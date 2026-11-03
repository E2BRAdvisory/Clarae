import { expect, test, type Route } from '@playwright/test';
import { BOB, ME, mockApi, signedIn } from './support';

// Sharing in the console (ADR-0037 §2, SharesManager of @memobrain/cloud-features over REST):
// creation of a share of a shared vault, rename and expiry (PATCH /shares/{id}), access through the
// directory, creation by a manager inside the share they manage (ADR-0041 §8), and the `sharing`
// flag. The API is a small in-memory server.

const V_SHARED = '0198f1c2-aaaa-7bbb-8ccc-000000000001';
const V_PRIVATE = '0198f1c2-aaaa-7bbb-8ccc-000000000002';

interface Share {
  id: string;
  vault_id: string;
  vault_name: string;
  resource_type: string;
  path_prefix?: string;
  display_name: string;
  owner_id: string;
  owner_name: string;
  created_at: string;
  expires_at?: string;
  grants: Record<string, unknown>[];
  /** Set for a share the user manages but does not own. */
  my_permission?: string;
  my_status?: string;
}

function shareServer() {
  const owned: Share[] = [];
  const vault = (id: string, name: string, kind: string) => ({
    id,
    owner_id: ME,
    name,
    kind,
    last_seq: 1,
    total_bytes: 0,
    file_count: 0,
    created_at: '2026-10-01T10:00:00Z',
  });
  const routes: Record<string, unknown> = {
    'GET /me': { id: ME },
    'GET /vaults': {
      items: [vault(V_SHARED, 'Team', 'shared'), vault(V_PRIVATE, 'Diary', 'private')],
      mounts: [],
    },
    'GET /shares': (route: Route) => ({
      items: new URL(route.request().url()).searchParams.get('scope') === 'owned' ? owned : [],
    }),
    'POST /shares': (_route: Route, body: Record<string, unknown>) => {
      const s: Share = {
        id: `s${owned.length + 1}`,
        vault_id: body['vault_id'] as string,
        vault_name: 'Team',
        resource_type: body['resource_type'] as string,
        ...(body['path_prefix'] ? { path_prefix: body['path_prefix'] as string } : {}),
        display_name: body['display_name'] as string,
        owner_id: ME,
        owner_name: 'Alice',
        created_at: '2026-11-01T10:00:00Z',
        grants: [],
      };
      owned.push(s);
      return s;
    },
    'GET /directory/users': [{ id: BOB, username: 'bob', display_name: 'Bob Smith' }],
  };
  return { owned, routes };
}

test('create a share of a folder, rename it, set an expiry, give access, revoke it', async ({
  page,
}) => {
  await signedIn(page);
  const srv = shareServer();
  const calls = await mockApi(page, {
    ...srv.routes,
    'PATCH /shares/s1': (_route: Route, body: Record<string, unknown>) => {
      const s = srv.owned[0]!;
      if (body['display_name']) s.display_name = body['display_name'] as string;
      if (body['expires_at']) s.expires_at = body['expires_at'] as string;
      return s;
    },
    [`PUT /shares/s1/grants/user/${BOB}`]: (_route: Route, body: Record<string, unknown>) => {
      const g = {
        principal_type: 'user',
        principal_id: BOB,
        principal_name: 'bob',
        permission: body['permission'],
        status: 'pending',
        created_at: '2026-11-01T10:00:00Z',
      };
      srv.owned[0]!.grants = [g];
      return g;
    },
    'DELETE /shares/s1': () => {
      srv.owned.splice(0, 1);
      return undefined;
    },
  });
  await page.goto('/shares');

  await page.getByRole('button', { name: 'New share' }).click();
  const create = page.getByRole('dialog', { name: 'New share' });
  // Only the shared vault is offered (D-02).
  await expect(create.getByLabel('Vault', { exact: true }).locator('option')).toHaveText(['Team']);
  await create.getByRole('radio', { name: 'A folder' }).check();
  await create.getByLabel('Folder', { exact: true }).fill('Projects/Alfa');
  await create.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('region', { name: 'Alfa' });
  await expect(share).toContainText('in Team · Projects/Alfa');
  expect(calls).toContain('POST /shares');

  await share.getByRole('button', { name: 'Edit Alfa' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit “Alfa”' });
  await edit.getByLabel('Name').fill('Alfa project');
  await edit.getByRole('checkbox', { name: 'No expiry' }).uncheck();
  await edit.getByLabel('Expires on').fill('2099-12-31');
  await edit.getByRole('button', { name: 'Save' }).click();
  const renamed = page.getByRole('region', { name: 'Alfa project' });
  await expect(renamed).toContainText('Expires');
  expect(calls).toContain('PATCH /shares/s1');

  const search = renamed.getByRole('form', { name: 'Add people or groups' });
  await search.getByLabel('Name or username').fill('bob');
  await search.getByRole('button', { name: 'Search' }).click();
  await search.getByRole('button', { name: 'Add Bob Smith' }).click();
  await expect(renamed.getByLabel('Permission of bob')).toHaveValue('viewer');
  expect(calls).toContain(`PUT /shares/s1/grants/user/${BOB}`);

  await renamed.getByRole('button', { name: 'Revoke Alfa project' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke “Alfa project”?' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(page.getByText('“Alfa project” revoked.')).toBeVisible();
  await expect(page.getByText('You have not shared anything yet')).toBeVisible();
});

test('with sharing turned off, the page says so and the menu has no Sharing entry', async ({
  page,
}) => {
  await signedIn(page);
  const srv = shareServer();
  const calls = await mockApi(page, {
    ...srv.routes,
    'GET /config/effective': {
      version: 3,
      config: { features: { sharing: false } },
      locked_keys: [],
    },
  });
  await page.goto('/shares');
  await expect(page.getByText('Sharing is turned off by your administrator.')).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Sharing' })).toHaveCount(0);
  expect(calls).not.toContain('GET /shares');
});

test('a manager shares a subfolder of the folder they manage (ADR-0041 §8)', async ({ page }) => {
  await signedIn(page);
  const srv = shareServer();
  const V_COMPANY = '0198f1c2-aaaa-7bbb-8ccc-000000000009'; // ada's vault, not the user's
  const ADA = '0198f1c2-cccc-7bbb-8ccc-0000000000ad';
  srv.owned.push({
    id: 'm1',
    vault_id: V_COMPANY,
    vault_name: 'Company',
    resource_type: 'folder',
    path_prefix: 'Projects/Alfa',
    display_name: 'Alfa',
    owner_id: ADA,
    owner_name: 'ada',
    created_at: '2026-10-01T10:00:00Z',
    grants: [],
    my_permission: 'manager',
    my_status: 'accepted',
  });
  let posted: Record<string, unknown> = {};
  const calls = await mockApi(page, {
    ...srv.routes,
    'POST /shares': (_route: Route, body: Record<string, unknown>) => {
      posted = body;
      const s: Share = {
        id: 's2',
        vault_id: body['vault_id'] as string,
        vault_name: 'Company',
        resource_type: body['resource_type'] as string,
        path_prefix: body['path_prefix'] as string,
        display_name: body['display_name'] as string,
        owner_id: ADA,
        owner_name: 'ada',
        created_at: '2026-11-01T10:00:00Z',
        grants: [],
        my_permission: 'manager',
        my_status: 'accepted',
      };
      srv.owned.push(s);
      return s;
    },
  });
  await page.goto('/shares');

  const alfa = page.getByRole('region', { name: 'Alfa' });
  await expect(alfa).toContainText('only its owner can revoke it');
  await alfa.getByRole('button', { name: 'Share inside Alfa' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share inside “Alfa”' });
  await expect(dialog).toContainText('Inside “Alfa” · in Company · Projects/Alfa');
  await dialog.getByLabel('Subfolder', { exact: true }).fill('Drafts');
  await expect(dialog.getByLabel('Name')).toHaveValue('Drafts');
  await dialog.getByRole('button', { name: 'Share' }).click();

  const drafts = page.getByRole('region', { name: 'Drafts' });
  await expect(drafts).toContainText('in Company · Projects/Alfa/Drafts');
  await expect(drafts.getByRole('button', { name: /Revoke/ })).toHaveCount(0);
  expect(calls).toContain('POST /shares');
  expect(posted).toMatchObject({
    vault_id: V_COMPANY,
    resource_type: 'folder',
    path_prefix: 'Projects/Alfa/Drafts',
    display_name: 'Drafts',
  });
});
