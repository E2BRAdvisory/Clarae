import type { Page } from '@playwright/test';
import { onWeb } from './support';
import { expect, test, uuid, vault } from './cloud';

// Settings › Sync, «Files not sent» (ADR-0066). On the desktop the list comes from the Wails mock; in
// the browser the real Go core sends a note the REST mock of web/e2e/cloudMock.ts refuses, parks it,
// lists it, and sends it again on «Try again» once the server accepts it.

const NOTES = uuid(1);

async function openSyncSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible();
}

test('lists a file the server refused and sends it again on «Try again»', async ({
  page,
  cloud,
}) => {
  await cloud.openVault(
    page,
    { vaults: [vault(NOTES, 'Notes', 'shared')] },
    { open: NOTES, link: true, files: { 'Plan.md': '# plan' } },
  );

  if (onWeb()) {
    // The server refuses the note: the core parks it with the server's code.
    cloud.rest!.rejectPaths.set('Refused.md', {
      code: 'PATH_INVALID',
      detail: 'refused by the test',
    });
    await page.evaluate(async () => {
      const app = (
        window as unknown as {
          go: { app: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
        }
      ).go.app;
      const id = ((await app['VaultAPI']!['ListOpen']!()) as { id: string }[])[0]!.id;
      await app['VaultAPI']!['WriteNote']!(id, 'Refused.md', '# refused', '');
      await app['SyncAPI']!['SyncNow']!(id);
    });
  } else {
    await page.evaluate(() => {
      const w = window as unknown as {
        __mock: {
          vaults: Map<string, { info: { id: string } }>;
          sync: { unsent: Map<string, unknown[]> };
        };
      };
      const id = [...w.__mock.vaults.values()][0]!.info.id;
      w.__mock.sync.unsent.set(id, [
        {
          path: 'Refused.md',
          isDir: false,
          reason: 'rejected',
          code: 'PATH_INVALID',
          detail: 'refused by the test',
          retryable: true,
          info: false,
        },
      ]);
    });
  }

  await openSyncSettings(page);
  const group = page.locator('.unsent-group', {
    has: page.getByRole('heading', { name: 'Refused by the server (1)' }),
  });
  await expect(group).toBeVisible({ timeout: 30_000 });
  await expect(group).toContainText('Refused.md');
  await expect(group).toContainText('PATH_INVALID: refused by the test');

  // The server accepts it now: «Try again» puts it back in the queue and the list empties.
  cloud.rest?.rejectPaths.delete('Refused.md');
  await page.getByRole('button', { name: 'Try again Refused.md' }).click();
  await expect(page.getByText('All files have been sent.')).toBeVisible({ timeout: 30_000 });
});
