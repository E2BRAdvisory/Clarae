import { expect, test } from '@playwright/test';
import { ME, mockApi, signedIn } from './support';

const vaults = {
  items: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      owner_id: ME,
      name: 'Diary',
      kind: 'private',
      last_seq: 0,
      total_bytes: 0,
      file_count: 0,
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
  mounts: [],
};

test('the account page downloads the data and guards the deletion', async ({ page }) => {
  await signedIn(page);
  let deleteBody: unknown;
  const calls = await mockApi(page, {
    'GET /me': { id: ME, username: 'alice' },
    'GET /vaults': vaults,
    'GET /me/export': { profile: { id: ME }, notice: 'x' },
    'DELETE /me': (_route: unknown, body: unknown) => {
      deleteBody = body;
      return undefined;
    },
  });
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download my data' }).click();
  expect((await download).suggestedFilename()).toMatch(/^nodus-account-\d{4}-\d{2}-\d{2}\.json$/);
  expect(calls).toContain('GET /me/export');

  await page.getByRole('button', { name: 'Delete my account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
  await expect(dialog.getByRole('alert')).toContainText('irrecoverable');
  const confirm = dialog.getByRole('button', { name: 'Delete permanently' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type your username/).fill('alice');
  await expect(confirm).toBeDisabled(); // the data-loss acknowledgement is still missing
  await dialog.getByRole('checkbox').check();
  await expect(confirm).toBeEnabled();
  expect(calls).not.toContain('DELETE /me');
  await confirm.click();
  await expect.poll(() => deleteBody).toEqual({ confirm: 'alice', acknowledge_data_loss: true });
});
