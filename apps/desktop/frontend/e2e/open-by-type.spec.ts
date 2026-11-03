import type { Page } from '@playwright/test';
import { expect, onWeb, openVault, test } from './support';

// Opening a file by its type (ADR-0047): the app shows notes and media in a tab; any other file
// opens with the system's application on the desktop (here the Wails mock records the call), or is
// offered as a download in the browser (the real core on the web).

// A 1×1 transparent PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const ZIP = btoa('PK\u0003\u0004 not really a zip');

const systemOpens = (page: Page): Promise<string[]> =>
  page.evaluate(
    () => (window as unknown as { __mock: { systemOpens: string[] } }).__mock.systemOpens,
  );

const tabTitles = (page: Page) => page.locator('.tabbar .tab');

test('a picture opens in a tab', async ({ page }) => {
  await openVault(page, { 'Readme.md': '# Readme\n' }, { 'Media/photo.png': PNG });
  await page.locator('.tree .node', { hasText: 'Media' }).click();
  await page.locator('.tree .node', { hasText: 'photo.png' }).click();
  await expect(page.locator('.attachment-view img')).toBeVisible();
});

test('an archive opens outside the app, never in a tab', async ({ page }) => {
  await openVault(page, { 'Readme.md': '# Readme\n' }, { 'Docs/data.zip': ZIP });
  await page.locator('.tree .node', { hasText: 'Docs' }).click();
  const before = await tabTitles(page).count();
  await page.locator('.tree .node', { hasText: 'data.zip' }).click();

  if (onWeb()) {
    const dialog = page.getByRole('dialog', { name: 'Open File' });
    await expect(dialog).toContainText(
      'The file data.zip cannot be shown here. Do you want to download it?',
    );
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toBe('data.zip');
  } else {
    await expect
      .poll(() => systemOpens(page))
      .toEqual([expect.stringMatching(/:Docs\/data\.zip$/)]);
  }
  await expect(tabTitles(page)).toHaveCount(before);
});

test('cancelling the download in the browser leaves everything as it was', async ({ page }) => {
  test.skip(!onWeb(), 'the desktop opens the file without asking');
  await openVault(page, { 'Readme.md': '# Readme\n' }, { 'data.zip': ZIP });
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('.tree .node', { hasText: 'data.zip' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open File' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(downloads).toBe(0);
});
