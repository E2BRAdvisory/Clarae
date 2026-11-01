import type { Page } from '@playwright/test';
import { expect, test, openVault } from './support';

async function openNote(page: Page): Promise<void> {
  await openVault(page, { 'Note.md': 'hello' });
  await page.getByText('Note', { exact: true }).first().dblclick();
}

test('the editing toolbar formats the note', async ({ page }) => {
  await openNote(page);
  const bar = page.getByRole('toolbar', { name: 'Editing toolbar' });
  await expect(bar).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect(page.locator('.cm-content')).toContainText('**hello**');
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.cm-content')).not.toContainText('**');
  await bar.getByRole('button', { name: 'Table' }).click();
  await expect(page.locator('.cm-content')).toContainText('Column 1');
});
