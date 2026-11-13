import { expect, test, type Page } from '@playwright/test';
import { VAULTS_PATH, api, bind, markersKey, signIn } from './support';

// A private (end-to-end encrypted) vault in the browser workbench: the copy the browser keeps is clear
// text, so locking it removes the copy, unless that would lose changes that were not uploaded (D-04,
// ADR-0029 §6). Start the stack first (after `task web-build`):
//   scripts/run-desktop-with-cloud.sh --cloud-only --keep
// Run with: yarn workspace @clarae/web e2e:cloud

const PASSPHRASE = 'correct horse battery staple 42';

interface Status {
  pending: number;
  phase: string;
}

/** Whether this browser holds the folder of a vault (OPFS `accounts/<key>/fs/vaults/<id>`). */
const holdsCopy = async (page: Page, cloudId: string): Promise<boolean> =>
  page.evaluate(
    async (path) => {
      try {
        let d = await navigator.storage.getDirectory();
        for (const name of path) d = await d.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    },
    [...(await VAULTS_PATH(page)), cloudId],
  );

const markers = async (page: Page): Promise<Record<string, { pending: number; dirty: boolean }>> =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}') as never,
    await markersKey(page),
  );

const read = async (page: Page, id: string, path: string): Promise<string> => {
  try {
    return (await bind<{ content: string }>(page, 'VaultAPI', 'ReadNote', id, path)).content;
  } catch {
    return '';
  }
};

/**
 * Creates a private vault from the browser's own core, as the desktop's "connect to the cloud" does:
 * a folder of this browser is linked as a new private vault and uploaded. The workbench of a scratch
 * shared vault provides the running core.
 */
async function createPrivateVault(page: Page, name: string): Promise<string> {
  const scratch = await api<{ id: string }>(page, 'POST', '/vaults', {
    name: `${name}-scratch`,
    kind: 'shared',
  });
  await page.goto(`/vaults/${scratch.id}/open`);
  await expect(page.locator('header.titlebar .title')).toHaveText(`${name}-scratch`, {
    timeout: 120_000,
  });
  const local = await bind<{ id: string }>(page, 'VaultAPI', 'OpenVault', `/vaults/new-${name}`);
  // Written before linking: the first upload takes the files already in the folder.
  await bind(
    page,
    'VaultAPI',
    'WriteNote',
    local.id,
    'Secret.md',
    '# Secret\n\nonly for my eyes\n',
    '',
  );
  const linked = await bind<{ cloudVaultId: string }>(
    page,
    'SyncAPI',
    'LinkNew',
    local.id,
    name,
    'private',
    PASSPHRASE,
  );
  await expect
    .poll(
      async () => {
        await bind(page, 'SyncAPI', 'SyncNow', local.id).catch(() => undefined);
        return (await bind<Status>(page, 'SyncAPI', 'Status', local.id)).pending;
      },
      { timeout: 90_000, intervals: [1000, 2000] },
    )
    .toBe(0);
  await expect
    .poll(
      async () =>
        (await api<{ items: unknown[] }>(page, 'GET', `/vaults/${linked.cloudVaultId}/tree`)).items
          .length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await bind(page, 'VaultAPI', 'CloseVault', local.id);
  return linked.cloudVaultId;
}

/** Opens the private vault and unlocks it in the workbench's own dialog. Resolves to its local id. */
async function openAndUnlock(page: Page, cloudId: string, name: string): Promise<string> {
  await page.goto(`/vaults/${cloudId}/open`);
  await expect(page.locator('header.titlebar .title')).toHaveText(name, { timeout: 120_000 });
  const dialog = page.getByRole('dialog', { name: 'Unlock encrypted vault' });
  await dialog.getByRole('textbox', { name: 'Passphrase' }).fill(PASSPHRASE);
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  return localIdOf(page, cloudId);
}

async function localIdOf(page: Page, cloudId: string): Promise<string> {
  const open = await bind<{ id: string; path: string }[]>(page, 'VaultAPI', 'ListOpen');
  return open.find((v) => v.path === `/vaults/${cloudId}`)!.id;
}

/** The "Lock now" button of the vault's sync settings. */
async function lockFromSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await page.getByRole('button', { name: 'Lock now' }).click();
}

const consoleHeading = (page: Page) => page.getByRole('heading', { name: 'My vaults' });

test.describe.configure({ mode: 'serial' });

let page: Page;
let cloudId = '';
const name = `web-private-${Date.now()}`;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  page = await signIn(context, 'user1');
  cloudId = await createPrivateVault(page, name);
});

test.afterAll(async () => {
  await page?.context().close();
});

test('locking a private vault with everything uploaded removes its copy and goes to the console', async () => {
  const id = await openAndUnlock(page, cloudId, name);
  // The content arrives encrypted and is decrypted in the browser.
  await expect
    .poll(() => read(page, id, 'Secret.md'), { timeout: 90_000 })
    .toContain('only for my eyes');
  expect(await holdsCopy(page, cloudId)).toBe(true);
  expect(Object.keys(await markers(page))).toContain(cloudId);

  await lockFromSettings(page);
  await expect(consoleHeading(page)).toBeVisible({ timeout: 60_000 });
  expect(await holdsCopy(page, cloudId)).toBe(false);
  expect(Object.keys(await markers(page))).not.toContain(cloudId);
});

test('locking offline keeps the changes not uploaded, and unlocking later uploads them', async () => {
  const id = await openAndUnlock(page, cloudId, name);
  await expect
    .poll(() => read(page, id, 'Secret.md'), { timeout: 90_000 })
    .toContain('only for my eyes');

  await page.context().setOffline(true);
  await bind(page, 'VaultAPI', 'WriteNote', id, 'Offline.md', 'written without a network\n', '');
  await lockFromSettings(page);
  const overlay = page.locator('.page-overlay');
  await expect(overlay).toContainText('Vault locked', { timeout: 90_000 });
  await expect(overlay).toContainText(
    /not uploaded yet (is|are) kept in this browser as clear text/,
  );
  expect(await holdsCopy(page, cloudId)).toBe(true);
  expect((await markers(page))[cloudId]?.pending).toBeGreaterThan(0);

  // Keep the copy for later.
  await page.context().setOffline(false);
  await overlay.getByRole('button', { name: 'Back to the console' }).click();
  await expect(consoleHeading(page)).toBeVisible({ timeout: 60_000 });

  // Opening it again asks for the passphrase before showing anything, then uploads.
  await page.goto(`/vaults/${cloudId}/open`);
  const gate = page.locator('.page-overlay');
  await expect(gate).toContainText('Changes not uploaded', { timeout: 120_000 });
  await expect(page.locator('header.titlebar')).toHaveCount(0);
  await gate.getByLabel('Passphrase').fill(PASSPHRASE);
  await gate.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.locator('header.titlebar .title')).toHaveText(name, { timeout: 120_000 });
  const again = await localIdOf(page, cloudId);
  expect(await read(page, again, 'Offline.md')).toContain('written without a network');
  await expect
    .poll(
      async () => {
        await bind(page, 'SyncAPI', 'SyncNow', again).catch(() => undefined);
        return (await bind<Status>(page, 'SyncAPI', 'Status', again)).pending;
      },
      { timeout: 90_000, intervals: [1000, 2000] },
    )
    .toBe(0);
  // The server now has the file (its path is opaque: count the entries).
  const tree = await api<{ items: unknown[] }>(page, 'GET', `/vaults/${cloudId}/tree`);
  expect(tree.items.length).toBeGreaterThanOrEqual(2);

  await lockFromSettings(page);
  await expect(consoleHeading(page)).toBeVisible({ timeout: 60_000 });
  expect(await holdsCopy(page, cloudId)).toBe(false);
});

test('the idle lock of the core removes the copy of an unattended vault', async () => {
  test.setTimeout(300_000);
  const id = await openAndUnlock(page, cloudId, name);
  await expect
    .poll(() => read(page, id, 'Secret.md'), { timeout: 90_000 })
    .toContain('only for my eyes');
  // The shortest auto-lock the core accepts; nobody touches the page afterwards.
  const settings = await bind<Record<string, unknown>>(page, 'SettingsAPI', 'Get');
  await bind(page, 'SettingsAPI', 'Set', { ...settings, vaultLockMinutes: 1 });
  try {
    // One minute of idleness, the core's 30 s sweep and its bounded upload.
    await expect(consoleHeading(page)).toBeVisible({ timeout: 200_000 });
    expect(await holdsCopy(page, cloudId)).toBe(false);
  } finally {
    await page.goto(`/vaults/${cloudId}/open`).catch(() => undefined);
    await expect(page.locator('header.titlebar .title'))
      .toHaveText(name, { timeout: 120_000 })
      .catch(() => undefined);
    await bind(page, 'SettingsAPI', 'Set', settings).catch(() => undefined);
  }
});
