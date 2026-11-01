import { expect, test, type Page } from '@playwright/test';
import { api, bind, signIn } from './support';

// Creating a private vault from the console (ADR-0037 §2): "New vault" opens the browser workbench on
// /vaults/new/open?kind=private&name=…, whose connect wizard asks for the passphrase and shows the
// recovery key once (the keys are made by the Go core, never in TypeScript); the page then continues
// as a normal open of the new vault. Start the stack first (after `task web-build`):
//   scripts/run-desktop-with-cloud.sh --cloud-only --keep
// Run with: yarn workspace @memobrain/web e2e:cloud

const PASSPHRASE = 'correct horse battery staple 42';
const MARKERS = 'memobrain.workbench.vaults';

interface Vault {
  id: string;
  name: string;
  kind: string;
  file_count: number;
}

/** The folders of this browser's vault copies (OPFS `fs/vaults/*`). */
const copies = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    try {
      const fs = await (await navigator.storage.getDirectory()).getDirectoryHandle('fs');
      const dir = await fs.getDirectoryHandle('vaults');
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys())
        names.push(name);
      return names;
    } catch {
      return [];
    }
  });

async function startCreation(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New vault' }).click();
  const dialog = page.getByRole('dialog', { name: 'New cloud vault' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('radio', { name: /Private/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/vaults\/new\/open\?kind=private/);
  await expect(page.getByRole('dialog', { name: 'Connect to the cloud' })).toBeVisible({
    timeout: 120_000,
  });
}

test('a private vault created from the console opens in the browser, encrypted', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await signIn(context, 'user1');
  const name = `Created-${Date.now()}`;
  await startCreation(page, name);

  const wizard = page.getByRole('dialog', { name: 'Connect to the cloud' });
  await expect(wizard).toContainText(name);
  await wizard.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await wizard.getByLabel('Repeat the passphrase').fill(PASSPHRASE);
  await wizard.getByRole('button', { name: 'Create encrypted vault' }).click();
  const key = (await wizard.getByLabel('Recovery key', { exact: true }).textContent()) ?? '';
  expect(key).toMatch(/^[A-Z2-7-]+$/);
  await wizard.getByLabel(/Type the recovery key/).fill(key);
  await wizard.getByRole('button', { name: 'I saved it' }).click();

  // The address names the new vault, and the workbench opens it under its name.
  await expect(page).toHaveURL(/\/vaults\/[0-9a-f-]{36}\/open$/, { timeout: 60_000 });
  const cloudId = /\/vaults\/([^/]+)\/open/.exec(page.url())?.[1] ?? '';
  await expect(page.locator('header.titlebar .title')).toHaveText(name, { timeout: 120_000 });
  const vaults = await api<{ items: Vault[] }>(page, 'GET', '/vaults');
  expect(vaults.items.find((v) => v.id === cloudId)).toMatchObject({ name, kind: 'private' });

  // Unlocked here, and treated as any private copy: its marker points at the folder it lives in.
  const local = (await bind<{ id: string }[]>(page, 'VaultAPI', 'ListOpen'))[0]!;
  expect(
    await bind<{ locked: boolean; kind: string }>(page, 'SyncAPI', 'Info', local.id),
  ).toMatchObject({ locked: false, kind: 'private' });
  const marker = await page.evaluate(
    ({ key, id }) => (JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>)[id],
    { key: MARKERS, id: cloudId },
  );
  expect(marker).toMatchObject({
    kind: 'private',
    localPath: expect.stringMatching(/^\/vaults\/new-/),
  });

  // A note written here is uploaded encrypted.
  await bind(page, 'VaultAPI', 'WriteNote', local.id, 'Secret.md', '# Secret\n', '');
  await expect
    .poll(
      async () => {
        await bind(page, 'SyncAPI', 'SyncNow', local.id).catch(() => undefined);
        return (await api<Vault>(page, 'GET', `/vaults/${cloudId}`)).file_count;
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);
  await context.close();
});

test('cancelling the creation goes back to the console and leaves nothing behind', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await signIn(context, 'user1');
  const before = await api<{ items: Vault[] }>(page, 'GET', '/vaults');
  const name = `Cancelled-${Date.now()}`;
  await startCreation(page, name);
  await page
    .getByRole('dialog', { name: 'Connect to the cloud' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.getByRole('heading', { name: 'My vaults' })).toBeVisible({ timeout: 60_000 });
  const after = await api<{ items: Vault[] }>(page, 'GET', '/vaults');
  expect(after.items.length).toBe(before.items.length);
  expect((await copies(page)).filter((n) => n.startsWith('new-'))).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), MARKERS)).toBeNull();
  await context.close();
});
