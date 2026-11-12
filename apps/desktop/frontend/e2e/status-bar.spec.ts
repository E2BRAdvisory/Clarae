import type { Page } from '@playwright/test';
import { expect, openVault, readVaultFile, test } from './support';
import { runCommand } from './drawingHelpers';

// The optional status bar (ADR-0035): off by default, turned on from the palette and remembered in
// .memobrain/appearance.json; figures of the active editor only.
const statusBar = async (page: Page) =>
  (
    JSON.parse((await readVaultFile(page, '.memobrain/appearance.json')) || '{}') as {
      statusBar?: boolean;
    }
  ).statusBar;

test('the palette turns the status bar on and off, and the vault remembers it', async ({
  page,
}) => {
  await openVault(page, { 'Home.md': '# Home\nhello brave world\n' });
  await page.locator('.tree .node', { hasText: 'Home' }).click();
  await expect(page.getByLabel('Note editor')).toBeVisible();
  const bar = page.getByRole('status', { name: 'Status bar' });
  await expect(bar).toHaveCount(0);

  await runCommand(page, 'toggle status bar');
  await expect(bar).toContainText('4 words, 25 chars');
  // reported when the tab opened, before any key. The line is exact; the column is not: in Live the caret
  // starts on the text of the heading, after its `# ` (ADR-0049)
  await expect(bar).toContainText('Ln 1, Col');
  await expect.poll(() => statusBar(page)).toBe(true);

  await page.getByLabel('Note editor').click();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(bar).toContainText('4 words, 25 chars selected');

  await bar.getByRole('button', { name: 'Mode: Live. Click to switch' }).click();
  await expect(bar.getByRole('button', { name: 'Mode: Source. Click to switch' })).toBeVisible();
  // in Source the position is the one of the text as written
  await page.getByLabel('Note editor').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(bar).toContainText('Ln 1, Col 1');
  await expect(bar).toContainText('4 words, 25 chars');

  await runCommand(page, 'toggle status bar');
  await expect(bar).toHaveCount(0);
  await expect.poll(() => statusBar(page)).toBe(false);
});
