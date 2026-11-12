import type { Page } from '@playwright/test';
import { expect, noteEditor, openVault, proseMirror, readVaultFile, test } from './support';

// The editing toolbar acts on the editor of its pane through the handle, so it formats a note in Live
// (Milkdown, ADR-0049) and in Source (CodeMirror). What the user reads differs (Source shows `**hello**` on
// the line, Live shows bold text), so the result is checked in the file.
async function openNote(page: Page): Promise<void> {
  await openVault(page, { 'Note.md': 'hello' });
  await page.getByText('Note', { exact: true }).first().dblclick();
}

const noteText = (page: Page) => () => readVaultFile(page, 'Note.md');

test('the editing toolbar formats the note', async ({ page }) => {
  await openNote(page);
  const bar = page.getByRole('toolbar', { name: 'Editing toolbar' });
  await expect(bar).toBeVisible();
  const editor = noteEditor(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect.poll(noteText(page)).toBe('**hello**');
  // the syntax is not on the line: the text is bold
  await expect(proseMirror(page).locator('strong')).toHaveText('hello');
  await expect(proseMirror(page)).not.toContainText('**');
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(noteText(page)).toBe('hello');
  await expect(editor).not.toContainText('**');
  await bar.getByRole('button', { name: 'Table' }).click();
  // a table of the Source editor starts with named columns, one of Live with empty cells: both are a table
  await expect.poll(noteText(page)).toMatch(/^\|.*\|\n\|[ :|-]+\|/m);
  await expect(proseMirror(page).locator('.milkdown-table-block')).toBeVisible();
});

test('the toolbar follows the mode: it formats the Source editor too', async ({ page }) => {
  await openNote(page);
  await page.getByRole('button', { name: 'Source' }).click();
  const bar = page.getByRole('toolbar', { name: 'Editing toolbar' });
  // Source is CodeMirror (the Milkdown editor is gone with the mode)
  const editor = page.getByLabel('Note editor');
  await expect(editor).toContainText('hello');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await bar.getByRole('button', { name: 'Italic' }).click();
  await expect(editor).toContainText('*hello*');
  await expect.poll(noteText(page)).toBe('*hello*');
});
