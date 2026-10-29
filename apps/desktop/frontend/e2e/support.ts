import { expect, type Page } from '@playwright/test';

/**
 * The same specs run twice (ADR-0029): against the desktop UI on the in-memory Wails mock (this
 * package's config), and against the vault workbench in the browser on the real Go core compiled to
 * WebAssembly (web/playwright.workbench-ui.config.ts sets E2E_TARGET=web). Only how a vault is opened
 * and filled differs; everything the specs do afterwards is the UI, identical in both.
 */
export const onWeb = process.env['E2E_TARGET'] === 'web';

/** Origin the app is served from (the specs check that nothing else is requested). */
export const appOrigin = process.env['E2E_ORIGIN'] ?? 'http://localhost:5199';

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    emit(name: string, payload: unknown): void;
  };
}

interface CoreWindow {
  go: { app: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> };
}

/** Opens a vault with the Files tab showing; optionally seeds notes first. */
export async function openVault(page: Page, files: Record<string, string> = {}): Promise<void> {
  if (onWeb) {
    // A folder of this browser, without a cloud (E2E builds only); a fresh name per test keeps vaults apart.
    const name = `ui-${Math.random().toString(36).slice(2, 10)}`;
    await page.goto(`/vaults/${name}/open?local`);
    await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible({ timeout: 90_000 });
    if (Object.keys(files).length === 0) return;
    await page.evaluate(async (seed) => {
      const app = (window as unknown as CoreWindow).go.app;
      const vault = ((await app['VaultAPI']!['ListOpen']!()) as { id: string }[])[0];
      if (!vault) throw new Error('vault not open');
      for (const [path, content] of Object.entries(seed))
        await app['VaultAPI']!['WriteNote']!(vault.id, path, content, '');
    }, files);
    return;
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  if (Object.keys(files).length === 0) return;
  await page.evaluate((seed) => {
    const w = window as unknown as MockWindow;
    const v = [...w.__mock.vaults.values()][0];
    if (!v) throw new Error('vault not open');
    for (const [p, c] of Object.entries(seed)) v.files.set(p, c);
    w.__mock.emit('vault:file-changed', { vaultId: v.info.id, paths: Object.keys(seed) });
  }, files);
}
