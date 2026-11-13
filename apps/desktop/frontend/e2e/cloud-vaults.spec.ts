import type { Page } from '@playwright/test';
import { onWeb, readVaultFile } from './support';
import { expect, test, uuid, vault, type CloudSeed } from './cloud';

// Settings > Cloud: the account's cloud vaults (ADR-0037 §2, @clarae/cloud-features over the
// bindings). On the desktop deleting the cloud vault the open folder is connected to disconnects the
// folder and keeps its files; in the browser the page is that cloud vault, which is deleted from the
// console, not from its own page. On the web the panels run on the real Go core against the REST
// mock of web/e2e/cloudMock.ts (the `cloud` fixture).

const NOTES = uuid(1);
const WORK = uuid(2);
const seed: CloudSeed = {
  vaults: [vault(NOTES, 'Notes', 'shared'), vault(WORK, 'Work', 'shared')],
};

async function openCloudSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Cloud', exact: true }).click();
}

test('rename, delete and restore cloud vaults from the settings', async ({ page, cloud }) => {
  // The open folder is connected to Notes and holds a note (on the web it is Notes' own page).
  await cloud.openVault(page, seed, { open: NOTES, link: true, files: { 'Plan.md': '# keep me' } });
  await openCloudSettings(page);

  const live = page.getByRole('table', { name: 'Cloud vaults' });
  await expect(live.getByRole('rowheader', { name: 'Notes' })).toBeVisible();
  // The desktop creates a cloud vault by connecting a folder: this one is connected already. The
  // browser creates them from the console.
  await expect(page.getByRole('button', { name: 'New vault' })).toHaveCount(0);

  // Rename the other vault.
  await page.getByRole('button', { name: 'Rename Work' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename vault' });
  await rename.getByLabel('Name').fill('Office');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(live.getByRole('rowheader', { name: 'Office' })).toBeVisible();
  if (cloud.rest) expect(cloud.rest.state.vaults.find((v) => v.id === WORK)?.name).toBe('Office');

  const gone = page.getByRole('table', { name: 'Deleted vaults' });
  let restored = 'Notes';
  if (onWeb()) {
    // The page's own vault is not deleted from its page: the console does that.
    await expect(page.getByRole('button', { name: 'Delete Notes' })).toBeDisabled();
    await page.getByRole('button', { name: 'Delete Office' }).click();
    const del = page.getByRole('dialog', { name: 'Delete “Office”?' });
    await expect(del).toContainText('Devices connected to it stop synchronizing');
    await del.getByRole('button', { name: 'Delete' }).click();
    await expect(gone.getByRole('rowheader', { name: 'Office' })).toBeVisible();
    await expect(live.getByRole('rowheader', { name: 'Office' })).toHaveCount(0);
    expect(cloud.rest?.state.vaults.find((v) => v.id === WORK)?.deleted_at).toBeTruthy();
    // The open vault keeps working, still connected.
    expect(await readVaultFile(page, 'Plan.md')).toBe('# keep me');
    restored = 'Office';
  } else {
    // Delete the one the open folder is connected to: the confirmation says the copy stays.
    await page.getByRole('button', { name: 'Delete Notes' }).click();
    const del = page.getByRole('dialog', { name: 'Delete “Notes”?' });
    await expect(del).toContainText('The copy on this device stays where it is');
    await del.getByRole('button', { name: 'Delete' }).click();
    await expect(gone.getByRole('rowheader', { name: 'Notes' })).toBeVisible();
    await expect(live.getByRole('rowheader', { name: 'Notes' })).toHaveCount(0);

    // The folder is disconnected and keeps its note.
    const local = await page.evaluate(async () => {
      const w = window as unknown as {
        __mock: { vaults: Map<string, { info: { id: string } }> };
        go: { app: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
      };
      const v = [...w.__mock.vaults.values()][0]!;
      const info = (await w.go.app['SyncAPI']!['Info']!(v.info.id)) as { linked: boolean };
      return info.linked;
    });
    expect(local).toBe(false);
    expect(await readVaultFile(page, 'Plan.md')).toBe('# keep me');
    // Now unconnected, the folder can create a cloud vault again from here.
    await expect(page.getByRole('button', { name: 'New vault' })).toBeVisible();
  }

  // Restore it.
  await gone.getByRole('button', { name: `Restore ${restored}` }).click();
  await expect(live.getByRole('rowheader', { name: restored })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Deleted vaults' })).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: `“${restored}” restored.` }),
  ).toBeVisible();
  if (cloud.rest) expect(cloud.rest.calls).toContain('POST restoreVault');
});

test('a cloud vault deleted elsewhere disconnects the folder and says so', async ({
  page,
  cloud,
}) => {
  await cloud.openVault(
    page,
    { vaults: [vault(NOTES, 'Notes', 'shared')] },
    { open: NOTES, link: true, files: { 'Plan.md': '# keep me' } },
  );
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible();

  // Deleted from the console: at its next cycle the core finds the vault gone, disconnects the
  // folder and tells the UI.
  if (cloud.rest) {
    cloud.rest.deleteVaultElsewhere(NOTES);
    await page.getByRole('button', { name: 'Sync now' }).click();
  } else {
    await page.evaluate(
      (id) =>
        (
          window as unknown as { __mock: { deleteCloudVaultElsewhere(id: string): void } }
        ).__mock.deleteCloudVaultElsewhere(id),
      NOTES,
    );
  }
  const notice = page.getByRole('dialog', { name: 'Cloud vault deleted' });
  await expect(notice).toContainText('“Notes” was deleted from the console or from another device');
  if (onWeb()) {
    // The copy belongs to the deleted vault: the page offers to remove it. Cancel keeps it.
    await expect(notice).toContainText('Remove it from this browser now?');
    await notice.getByRole('button', { name: 'Cancel' }).click();
  } else {
    await notice.getByRole('button', { name: 'OK' }).click();
    // Settings > Sync now offers to connect.
    await expect(page.getByRole('button', { name: 'Connect to the cloud' })).toBeVisible();
  }
  // Settings > Sync remembers why the link went, and the files stay.
  await expect(page.getByText(/cloud vault “Notes” was deleted elsewhere/)).toBeVisible();
  expect(await readVaultFile(page, 'Plan.md')).toBe('# keep me');
});
