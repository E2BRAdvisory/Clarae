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

  test('locking a vault removes its clear-text copy from the browser', async ({ page }) => {
    const { id } = await openWorkbench(page, 'forget');
    await bind(
      page,
      'VaultAPI',
      'WriteNote',
      id,
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
              id,
              'must not stay',
              'all',
              5,
            )
          ).hits?.length,
        { timeout: 30_000 },
      )
      .toBe(1);
    const present = () =>
      page.evaluate(async () => {
        const fs = await (await navigator.storage.getDirectory()).getDirectoryHandle('fs');
        try {
          await (await fs.getDirectoryHandle('vaults')).getDirectoryHandle('forget');
          return true;
        } catch {
          return false;
        }
      });
    expect(await present()).toBe(true);

    // What the idle timer does for a private vault: lock it, close it, delete this browser's copy.
    await page.evaluate(() =>
      (window as unknown as { __lockAndForget(): Promise<void> }).__lockAndForget(),
    );
    expect(await present()).toBe(false);

    // Opening it again finds nothing: neither the file nor its index survived.
    await page.reload();
    await expect(page.locator('header.titlebar .title')).toHaveText('forget', { timeout: 60_000 });
    const again = (await bind<{ id: string; name: string }[]>(page, 'VaultAPI', 'ListOpen')).find(
      (v) => v.name === 'forget',
    )!;
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
    await page.goto('/account');
    await page.getByRole('button', { name: 'Forget this browser' }).click();
    await expect(page.getByText('This browser no longer holds any vault.')).toBeVisible();
    expect(await folders()).toEqual([]);
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
    await page.goto('/vaults/x/open/extra?local');
    // The server answers with the console for this path: no workbench page (no #status), no core worker.
    await expect(page.locator('#status')).toHaveCount(0);
    await expect(page.locator('#root')).toBeAttached();
  });
});
