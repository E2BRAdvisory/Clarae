import type { Page } from '@playwright/test';
import {
  expect,
  liveEngine,
  noteEditor,
  openVault,
  proseMirror,
  readVaultFile,
  test,
} from './support';

// The editing toolbar acts on the editor of its pane through the handle, so it formats a note the same
// way in Live on either engine (CodeMirror or Milkdown, ADR-0049). What the user reads in Live differs
// (CodeMirror shows `**hello**` on the line, Milkdown shows bold text), so the result is checked in the
// file, which is the same.
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
  if (liveEngine() === 'milkdown') {
    // the syntax is not on the line: the text is bold
    await expect(proseMirror(page).locator('strong')).toHaveText('hello');
    await expect(proseMirror(page)).not.toContainText('**');
  } else {
    await expect(editor).toContainText('**hello**');
  }
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(noteText(page)).toBe('hello');
  await expect(editor).not.toContainText('**');
  await bar.getByRole('button', { name: 'Table' }).click();
  // a table of the Source editor starts with named columns, one of Live with empty cells: both are a table
  await expect.poll(noteText(page)).toMatch(/^\|.*\|\n\|[ :|-]+\|/m);
  if (liveEngine() === 'milkdown')
    await expect(proseMirror(page).locator('.milkdown-table-block')).toBeVisible();
});

test('the toolbar follows the mode: it formats the Source editor too', async ({ page }) => {
  await openNote(page);
  await page.getByRole('button', { name: 'Source' }).click();
  const bar = page.getByRole('toolbar', { name: 'Editing toolbar' });
  // Source is CodeMirror on both engines (the Milkdown one is gone with the mode)
  const editor = page.getByLabel('Note editor');
  await expect(editor).toContainText('hello');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await bar.getByRole('button', { name: 'Italic' }).click();
  await expect(editor).toContainText('*hello*');
  await expect.poll(noteText(page)).toBe('*hello*');
});
