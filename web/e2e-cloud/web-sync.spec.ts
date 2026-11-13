import { expect, test, type Page } from '@playwright/test';
import { api, bind, signIn } from './support';

// The vault workbench against a real cloud: Keycloak login, the real API, PostgreSQL and S3. Two browser
// contexts are two devices (each has its own OPFS, so its own copy of the vault and its own sync state).
// Start the stack first: scripts/run-desktop-with-cloud.sh --cloud-only --keep   (after `task web-build`).
// Run with: yarn workspace @clarae/web e2e:cloud

async function openVault(page: Page, vaultId: string, name: string): Promise<string> {
  await page.goto(`/vaults/${vaultId}/open`);
  await expect(page.locator('header.titlebar .title')).toHaveText(name, { timeout: 120_000 });
  const vault = (await bind<{ id: string; path: string }[]>(page, 'VaultAPI', 'ListOpen')).find(
    (v) => v.path === `/vaults/${vaultId}`,
  );
  return vault!.id;
}

const read = async (page: Page, id: string, path: string): Promise<string> => {
  try {
    return (await bind<{ content: string }>(page, 'VaultAPI', 'ReadNote', id, path)).content;
  } catch {
    return '';
  }
};

test.describe.configure({ mode: 'serial' });

test('a note written in one browser reaches another, and merges concurrent edits', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const a = await browser.newContext();
  const b = await browser.newContext();
  const consoleA = await signIn(a, 'user1');
  const consoleB = await signIn(b, 'user1');

  // A shared vault (not end-to-end encrypted: the server keeps readable files, the workbench syncs them).
  const title = `web-sync-${Date.now()}`;
  const created = await api<{ id: string }>(consoleA, 'POST', '/vaults', {
    name: title,
    kind: 'shared',
  });
  const vaultId = created.id;

  // The console offers to open it; both browsers do.
  await consoleA.reload();
  await expect(consoleA.getByRole('link', { name: `Open ${title} in the browser` })).toBeVisible();

  const pageA = consoleA;
  const pageB = consoleB;
  const idA = await openVault(pageA, vaultId, title);
  const idB = await openVault(pageB, vaultId, title);

  // The browser registered itself as a device of its own.
  const devices = await api<{ items: { platform: string }[] }>(pageA, 'GET', '/me/devices');
  expect(devices.items.some((d) => d.platform === 'web')).toBe(true);

  // 1. A writes, B receives it.
  await bind(
    pageA,
    'VaultAPI',
    'WriteNote',
    idA,
    'Shared.md',
    'line one\n\nline two\n\nline three\n',
    '',
  );
  await bind(pageA, 'SyncAPI', 'SyncNow', idA);
  await expect
    .poll(
      async () => {
        await bind(pageB, 'SyncAPI', 'SyncNow', idB).catch(() => undefined);
        return read(pageB, idB, 'Shared.md');
      },
      { timeout: 90_000, intervals: [1000, 2000, 3000] },
    )
    .toContain('line two');

  // The server holds the file as a revision (what a desktop would pull too).
  const tree = await api<{ items: { path: string }[] }>(pageA, 'GET', `/vaults/${vaultId}/tree`);
  expect(tree.items.map((e) => e.path)).toContain('Shared.md');

  // 2. Both edit different lines at the same time, offline from each other; the client-side 3-way merge keeps both.
  await bind(pageA, 'SyncAPI', 'SetPaused', idA, true);
  await bind(pageB, 'SyncAPI', 'SetPaused', idB, true);
  const baseA = await bind<{ hash: string; content: string }>(
    pageA,
    'VaultAPI',
    'ReadNote',
    idA,
    'Shared.md',
  );
  const baseB = await bind<{ hash: string; content: string }>(
    pageB,
    'VaultAPI',
    'ReadNote',
    idB,
    'Shared.md',
  );
  await bind(
    pageA,
    'VaultAPI',
    'WriteNote',
    idA,
    'Shared.md',
    baseA.content.replace('line one', 'LINE ONE from A'),
    baseA.hash,
  );
  await bind(
    pageB,
    'VaultAPI',
    'WriteNote',
    idB,
    'Shared.md',
    baseB.content.replace('line three', 'LINE THREE from B'),
    baseB.hash,
  );
  await bind(pageA, 'SyncAPI', 'SetPaused', idA, false);
  await bind(pageA, 'SyncAPI', 'SyncNow', idA);
  await expect
    .poll(
      async () =>
        (await api<{ items: { path: string }[] }>(pageA, 'GET', `/vaults/${vaultId}/tree`)).items
          .length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await bind(pageB, 'SyncAPI', 'SetPaused', idB, false);

  const settled = async (p: Page, id: string): Promise<string> => {
    await bind(p, 'SyncAPI', 'SyncNow', id).catch(() => undefined);
    return read(p, id, 'Shared.md');
  };
  for (const [p, id] of [
    [pageA, idA],
    [pageB, idB],
  ] as const) {
    await expect
      .poll(() => settled(p, id), { timeout: 120_000, intervals: [1500, 3000] })
      .toMatch(/LINE ONE from A[\s\S]*LINE THREE from B/);
  }

  await a.close();
  await b.close();
});
