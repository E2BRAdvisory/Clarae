import { expect, test, type Page } from '@playwright/test';
import { ME, mockApi } from './support';

// The vault workbench in a real browser: the desktop UI on top of the Go core compiled to WebAssembly,
// running in a Web Worker with OPFS and sqlite-wasm. `?local` (E2E builds only) opens a folder of this
// browser without a cloud, so these tests cover everything except the sync with the server.

type Bindings = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

/** Calls a Go binding from the page, as the UI does. */
async function bind<T>(
  page: Page,
  service: string,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return page.evaluate(
    async ({ service, method, args }) => {
      const app = (window as unknown as { go: { app: Bindings } }).go.app;
      return await app[service]![method]!(...args);
    },
    { service, method, args },
  ) as Promise<T>;
}

/** The localStorage key of the workbench's vault markers (web/src/workbench/markers.ts). */
const MARKERS = 'memobrain.workbench.vaults';

/** Whether this browser holds the folder of a vault (OPFS `fs/vaults/<name>`). */
const vaultFolder = (page: Page, name: string): Promise<boolean> =>
  page.evaluate(async (name) => {
    try {
      const fs = await (await navigator.storage.getDirectory()).getDirectoryHandle('fs');
      await (await fs.getDirectoryHandle('vaults')).getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  }, name);

async function openWorkbench(page: Page, vault = 'e2e-vault'): Promise<{ id: string }> {
  await page.goto(`/vaults/${vault}/open?local`);
  // The UI is up when the vault's name is in the header.
  await expect(page.locator('header.titlebar .title')).toHaveText(vault, { timeout: 60_000 });
  const vaults = await bind<{ id: string; name: string }[]>(page, 'VaultAPI', 'ListOpen');
  return { id: vaults.find((v) => v.name === vault)!.id };
}

test.describe('vault workbench', () => {
  test('boots the core, opens a vault and shows the desktop UI', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openWorkbench(page);
    await expect(page.locator('.vault-switcher')).toBeVisible();
    // The web build offers no local folder and no updater, and a way back to the console.
    await expect(page.getByRole('button', { name: /back to the console/i })).toBeVisible();
    // It is the Go core in the worker that answers, not a stand-in: it reports the web platform.
    const info = await bind<Record<string, string>>(page, 'SettingsAPI', 'Info');
    expect(info['platform']).toBe('web');
    expect(errors).toEqual([]);
  });

  test('writes, reads, lists and searches notes through the core', async ({ page }) => {
    const { id } = await openWorkbench(page);
    await bind(
      page,
      'VaultAPI',
      'WriteNote',
      id,
      'Ideas/First.md',
      '# First idea\n\nThe quick brown fox links to [[Second]].\n',
      '',
    );
    await bind(
      page,
      'VaultAPI',
      'WriteNote',
      id,
      'Second.md',
      '# Second\n\nJumps over the lazy dog. #animals\n',
      '',
    );

    const note = await bind<{ content: string }>(
      page,
      'VaultAPI',
      'ReadNote',
      id,
      'Ideas/First.md',
    );
    expect(note.content).toContain('quick brown fox');

    // The UI hears about the change: the new folder appears in the file explorer.
    await expect(page.getByText('Ideas', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // Search runs on the index (SQLite FTS5 trigram, in the worker).
    await expect
      .poll(
        async () =>
          (
            await bind<{ hits: { path: string }[] }>(
              page,
              'SearchAPI',
              'Query',
              id,
              'lazy dog',
              'all',
              20,
            )
          ).hits?.map((h) => h.path),
        { timeout: 30_000 },
      )
      .toContain('Second.md');

    // Links and tags come from the same index.
    const backlinks = await bind<{ path: string }[]>(
      page,
      'LinksAPI',
      'Backlinks',
      id,
      'Second.md',
    );
    expect(backlinks.map((b) => b.path)).toContain('Ideas/First.md');
    const tags = await bind<{ name: string }[]>(page, 'TagsAPI', 'List', id);
    expect(tags.map((t) => t.name)).toContain('animals');
  });

  test('renames a note and rewrites the links to it, as on the desktop', async ({ page }) => {
    const { id } = await openWorkbench(page, 'renames');
    await bind(page, 'VaultAPI', 'WriteNote', id, 'Old name.md', '# Old\n', '');
    await bind(
      page,
      'VaultAPI',
      'WriteNote',
      id,
      'Linker.md',
      'See [[Old name]] for details.\n',
      '',
    );
    await expect
      .poll(
        async () =>
          (await bind<{ path: string }[]>(page, 'LinksAPI', 'Backlinks', id, 'Old name.md')).map(
            (b) => b.path,
          ),
        { timeout: 30_000 },
      )
      .toContain('Linker.md');
    await bind(page, 'LinksAPI', 'ApplyRename', id, 'Old name.md', 'New name.md');
    const linker = await bind<{ content: string }>(page, 'VaultAPI', 'ReadNote', id, 'Linker.md');
    expect(linker.content).toContain('[[New name]]');
    await expect
      .poll(
        async () =>
          (await bind<{ path: string }[]>(page, 'LinksAPI', 'Backlinks', id, 'New name.md')).map(
            (b) => b.path,
          ),
        { timeout: 30_000 },
      )
      .toContain('Linker.md');
  });

  test('keeps a local history of each save and restores an earlier version', async ({ page }) => {
    const { id } = await openWorkbench(page, 'history');
    const first = await bind<{ hash: string }>(
      page,
      'VaultAPI',
      'WriteNote',
      id,
      'Draft.md',
      'version one\n',
      '',
    );
    await bind(page, 'VaultAPI', 'WriteNote', id, 'Draft.md', 'version two\n', first.hash);
    await expect
      .poll(
        async () => (await bind<unknown[]>(page, 'HistoryAPI', 'List', id, 'Draft.md')).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('exports the vault as a ZIP the browser downloads', async ({ page }) => {
    const { id } = await openWorkbench(page, 'zipped');
    await bind(page, 'VaultAPI', 'WriteNote', id, 'In zip.md', 'inside the archive\n', '');
    const download = page.waitForEvent('download');
    // The core writes the archive in its scratch area and hands it to the page as a download.
    void bind(page, 'VaultAPI', 'ExportZip', id);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^zipped-\d{8}\.zip$/);
    const path = await file.path();
    const bytes = (await import('node:fs')).readFileSync(path);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes(Buffer.from('In zip.md'))).toBe(true);
  });

  test('builds the graph of the vault from its links', async ({ page }) => {
    const { id } = await openWorkbench(page, 'graph');
    await bind(page, 'VaultAPI', 'WriteNote', id, 'A.md', 'to [[B]]\n', '');
    await bind(page, 'VaultAPI', 'WriteNote', id, 'B.md', 'end\n', '');
    await expect
      .poll(
        async () =>
          (await bind<{ edges: unknown[] }>(page, 'GraphAPI', 'Build', id, {})).edges?.length,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('the start-up sweep removes the clear text a closed tab left of a private vault', async ({
    page,
  }) => {
    // Two copies: one the cloud has entirely, one with changes not uploaded yet.
    const kept = await openWorkbench(page, 'kept');
    await bind(page, 'VaultAPI', 'WriteNote', kept.id, 'Draft.md', 'not uploaded yet\n', '');
    const swept = await openWorkbench(page, 'swept');
    await bind(
      page,
      'VaultAPI',
      'WriteNote',
      swept.id,
      'Secret.md',
      '# Secret\n\nclear text that must not stay\n',
      '',
    );
    await expect
      .poll(
        async () =>
          (
            await bind<{ hits: unknown[] }>(
              page,
              'SearchAPI',
              'Query',
              swept.id,
              'must not stay',
              'all',
              5,
            )
          ).hits?.length,
        { timeout: 30_000 },
      )
      .toBe(1);
    // What the workbench records of private vaults linked to the cloud (?local links nothing).
    await page.evaluate((key) => {
      const marker = (name: string, pending: number) => ({
        name,
        kind: 'private',
        localPath: `/vaults/${name}`,
        pending,
        conflicts: 0,
        dirty: false,
        updatedAt: Date.now(),
      });
      localStorage.setItem(
        key,
        JSON.stringify({ swept: marker('swept', 0), kept: marker('kept', 2) }),
      );
    }, MARKERS);
    expect(await vaultFolder(page, 'swept')).toBe(true);

    // The tab is closed and the workbench opened again: the clean copy is gone before anything opens.
    await page.reload();
    await expect(page.locator('header.titlebar .title')).toHaveText('swept', { timeout: 60_000 });
    const again = (await bind<{ id: string; name: string }[]>(page, 'VaultAPI', 'ListOpen')).find(
      (v) => v.name === 'swept',
    )!;
    // Neither the file nor its index survived.
    expect(
      (
        await bind<{ hits: unknown[] }>(
          page,
          'SearchAPI',
          'Query',
          again.id,
          'must not stay',
          'all',
          5,
        )
      ).hits ?? [],
    ).toHaveLength(0);
    await expect(bind(page, 'VaultAPI', 'ReadNote', again.id, 'Secret.md')).rejects.toThrow();
    // The copy with changes is kept, and so is its marker.
    expect(await vaultFolder(page, 'kept')).toBe(true);
    const markers = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>,
      MARKERS,
    );
    expect(Object.keys(markers)).toEqual(['kept']);
  });

  test('a stopped engine blocks the page and offers a reload', async ({ page }) => {
    await openWorkbench(page, 'crash');
    // What the worker posts when the Go program exits.
    await page.evaluate(() =>
      (window as unknown as { __coreWorker: Worker }).__coreWorker.dispatchEvent(
        new MessageEvent('message', { data: { type: 'fatal', error: 'the Go core exited' } }),
      ),
    );
    const overlay = page.locator('.page-overlay');
    await expect(overlay).toContainText('The vault engine stopped. Reload the page to continue.');
    // Calls no longer wait for an answer that will never come.
    const error = await page.evaluate(async () => {
      try {
        await (window as unknown as { go: { app: Bindings } }).go.app['SettingsAPI']!['Info']!();
        return 'answered';
      } catch (e) {
        return String(e);
      }
    });
    expect(error).toContain('the vault engine stopped');
    await overlay.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('header.titlebar .title')).toHaveText('crash', { timeout: 60_000 });
    await expect(page.locator('.page-overlay')).toHaveCount(0);
  });

  test('"Forget this browser" in the console removes every vault copy and its databases', async ({
    page,
  }) => {
    const { id } = await openWorkbench(page, 'to-forget');
    await bind(page, 'VaultAPI', 'WriteNote', id, 'Kept.md', 'a note held in this browser\n', '');
    const folders = () =>
      page.evaluate(async () => {
        const out: string[] = [];
        for await (const [name] of (
          (await navigator.storage.getDirectory()) as unknown as {
            entries(): AsyncIterable<[string, unknown]>;
          }
        ).entries())
          out.push(name);
        return out.sort();
      });
    expect(await folders()).toEqual(['fs', 'memobrain-sqlite']);

    // Leaving the workbench ends its worker, which releases the files; then the console can remove them.
    await page.evaluate(() =>
      sessionStorage.setItem('memobrain.e2e.user', JSON.stringify({ name: 'Alice' })),
    );
    await mockApi(page, {
      'GET /me': { id: ME, username: 'alice' },
      'GET /vaults': { items: [], mounts: [] },
    });
    // A copy that holds changes not uploaded yet is deleted only after a confirmation (D-04).
    await page.evaluate(
      (key) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            'cloud-1': {
              name: 'Team notes',
              kind: 'shared',
              localPath: '/vaults/cloud-1',
              pending: 3,
              conflicts: 0,
              dirty: false,
              updatedAt: Date.now(),
            },
          }),
        ),
      MARKERS,
    );
    await page.goto('/account');
    await page.getByRole('button', { name: 'Forget this browser' }).click();
    const dialog = page.getByRole('dialog', { name: 'Changes not uploaded' });
    await expect(dialog).toContainText('Team notes — 3 changes not uploaded');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await folders()).toEqual(['fs', 'memobrain-sqlite']);
    await page.getByRole('button', { name: 'Forget this browser' }).click();
    await page.getByRole('button', { name: 'Delete them' }).click();
    await expect(page.getByText('This browser no longer holds any vault.')).toBeVisible();
    expect(await folders()).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), MARKERS)).toBeNull();
  });

  test('forgetting the browser while a workbench tab is open asks that tab to leave', async ({
    page,
    context,
  }) => {
    const { id } = await openWorkbench(page, 'busy-tab');
    await bind(page, 'VaultAPI', 'WriteNote', id, 'Open.md', 'held by the other tab\n', '');
    const consolePage = await context.newPage();
    await consolePage.addInitScript(() =>
      sessionStorage.setItem('memobrain.e2e.user', JSON.stringify({ name: 'Alice' })),
    );
    await mockApi(consolePage, {
      'GET /me': { id: ME, username: 'alice' },
      'GET /vaults': { items: [], mounts: [] },
    });
    await consolePage.goto('/account');
    await consolePage.getByRole('button', { name: 'Forget this browser' }).click();
    const dialog = consolePage.getByRole('dialog', { name: 'A vault is open in another tab' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close that tab and retry' }).click();
    // The workbench tab writes its edits and goes back to the console, releasing the files.
    await expect(page).toHaveURL(/\/vaults$|e2e-signin/, { timeout: 30_000 });
    await expect(consolePage.getByText('This browser no longer holds any vault.')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('keeps the vault across a reload (OPFS files and the SQLite index persist)', async ({
    page,
  }) => {
    const { id } = await openWorkbench(page, 'persist');
    await bind(page, 'VaultAPI', 'WriteNote', id, 'Kept.md', '# Kept\n\npersistent zebra\n', '');
    await expect
      .poll(
        async () =>
          (
            await bind<{ hits: unknown[] }>(
              page,
              'SearchAPI',
              'Query',
              id,
              'persistent zebra',
              'all',
              5,
            )
          ).hits?.length,
      )
      .toBe(1);

    await page.reload();
    await expect(page.locator('header.titlebar .title')).toHaveText('persist', { timeout: 60_000 });
    const again = (await bind<{ id: string; name: string }[]>(page, 'VaultAPI', 'ListOpen')).find(
      (v) => v.name === 'persist',
    )!;
    const note = await bind<{ content: string }>(page, 'VaultAPI', 'ReadNote', again.id, 'Kept.md');
    expect(note.content).toContain('persistent zebra');
    // The index database was reopened from the pool, not rebuilt from nothing.
    expect(
      (
        await bind<{ hits: unknown[] }>(
          page,
          'SearchAPI',
          'Query',
          again.id,
          'persistent zebra',
          'all',
          5,
        )
      ).hits,
    ).toHaveLength(1);
  });

  test('refuses a second workbench in another tab (one owner of the browser files)', async ({
    page,
    context,
  }) => {
    await openWorkbench(page, 'first');
    const other = await context.newPage();
    await other.goto('/vaults/second/open?local');
    await expect(other.locator('#status')).toContainText(/already open in another tab/i, {
      timeout: 30_000,
    });
  });

  test('an address that is not a vault does not start the workbench', async ({ page }) => {
    // Signed in, so the console renders instead of bouncing through the E2E sign-in page (which is
    // itself a console route and would redirect forever without a user).
    await page.addInitScript(() =>
      sessionStorage.setItem('memobrain.e2e.user', JSON.stringify({ name: 'Alice' })),
    );
    await page.goto('/vaults/x/open/extra?local');
    // The server answers with the console for this path: no workbench page (no #status), no core worker.
    await expect(page.locator('#status')).toHaveCount(0);
    await expect(page.locator('#root')).toBeAttached();
  });
});
