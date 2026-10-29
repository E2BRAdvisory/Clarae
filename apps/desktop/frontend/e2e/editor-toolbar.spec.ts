import { expect, test, type Page } from '@playwright/test';

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    emit(name: string, payload: unknown): void;
  };
}

async function openNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    const v = [...w.__mock.vaults.values()][0];
    if (!v) throw new Error('vault not open');
    v.files.set('Note.md', 'hello');
    w.__mock.emit('vault:file-changed', { vaultId: v.info.id, paths: ['Note.md'] });
  });
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
