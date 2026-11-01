import { expect, test, type Page } from '@playwright/test';

// Settings > Cloud: the account's cloud vaults (ADR-0037 §2, @memobrain/cloud-features over the
// bindings). Deleting the cloud vault the open folder is connected to disconnects the folder and
// keeps its files.

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    sync: { cloudVaults: Record<string, unknown>[] };
  };
  go: { app: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> };
}

async function openVault(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
}

async function openCloudSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Cloud', exact: true }).click();
}

test('rename, delete and restore cloud vaults from the settings', async ({ page }) => {
  await openVault(page);
  await openCloudSettings(page);
  await page.getByLabel('Server address').fill('https://memobrain.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();

  // Two cloud vaults; the open folder is connected to the first one and holds a note.
  await page.evaluate(async () => {
    const w = window as unknown as MockWindow;
    for (const [i, name] of ['Notes', 'Work'].entries())
      w.__mock.sync.cloudVaults.push({
        id: `cloud-${i + 1}`,
        ownerId: 'user-1',
        name,
        kind: 'shared',
        totalBytes: 2048,
        fileCount: 2,
        lastSeq: 3,
        createdAt: '2026-10-01T10:00:00Z',
      });
    const v = [...w.__mock.vaults.values()][0]!;
    v.files.set('Plan.md', '# keep me');
    await w.go.app['SyncAPI']!['LinkExisting']!(v.info.id, 'cloud-1');
  });
  // Another section and back: the list is fetched again.
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Cloud', exact: true }).click();

  const live = page.getByRole('table', { name: 'Cloud vaults' });
  await expect(live.getByRole('rowheader', { name: 'Notes' })).toBeVisible();
  // The desktop creates a cloud vault by connecting a folder: this one is connected already.
  await expect(page.getByRole('button', { name: 'New vault' })).toHaveCount(0);

  // Rename the other vault.
  await page.getByRole('button', { name: 'Rename Work' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename vault' });
  await rename.getByLabel('Name').fill('Office');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(live.getByRole('rowheader', { name: 'Office' })).toBeVisible();

  // Delete the one the open folder is connected to: the confirmation says the copy stays.
  await page.getByRole('button', { name: 'Delete Notes' }).click();
  const del = page.getByRole('dialog', { name: 'Delete “Notes”?' });
  await expect(del).toContainText('The copy on this device stays where it is');
  await del.getByRole('button', { name: 'Delete' }).click();
  const gone = page.getByRole('table', { name: 'Deleted vaults' });
  await expect(gone.getByRole('rowheader', { name: 'Notes' })).toBeVisible();
  await expect(live.getByRole('rowheader', { name: 'Notes' })).toHaveCount(0);

  // The folder is disconnected and keeps its note.
  const local = await page.evaluate(async () => {
    const w = window as unknown as MockWindow;
    const v = [...w.__mock.vaults.values()][0]!;
    const info = (await w.go.app['SyncAPI']!['Info']!(v.info.id)) as { linked: boolean };
    return { linked: info.linked, note: v.files.get('Plan.md') };
  });
  expect(local).toEqual({ linked: false, note: '# keep me' });
  // Now unconnected, the folder can create a cloud vault again from here.
  await expect(page.getByRole('button', { name: 'New vault' })).toBeVisible();

  // Restore it.
  await gone.getByRole('button', { name: 'Restore Notes' }).click();
  await expect(live.getByRole('rowheader', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Deleted vaults' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '“Notes” restored.' })).toBeVisible();
});
