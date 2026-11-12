import type { Page } from '@playwright/test';
import { answerPrompt, runCommand } from './drawingHelpers';
import { expect, noteEditor, openVault, proseMirror, readVaultFile, test } from './support';

// Find and replace in the note, and go to a line (ADR-0049, A-W5c). The commands are the same in both
// modes: Live (Milkdown) shows the find bar of the editor (translated, with regular expression and match
// case), Source (CodeMirror) draws its own search panel. The flow is the same; each panel is asserted in
// its own test, and the result is read from the file.
const NOTE = 'alpha beta\n\nalpha gamma\n\nplain Alpha\n';

async function openNote(page: Page, note = NOTE): Promise<void> {
  await openVault(page, { 'Note.md': note });
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  await expect(noteEditor(page)).toBeVisible();
}

const file = (page: Page) => () => readVaultFile(page, 'Note.md');

// The CodeMirror editor of Source (the one of Live has no name while Live shows).
const source = (page: Page) => page.getByLabel('Note editor');

async function openSource(page: Page, note = NOTE): Promise<void> {
  await openNote(page, note);
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(source(page)).toBeVisible();
}

const findBar = (page: Page) => page.getByRole('search', { name: 'Find and replace in the note' });

test('Mod+F finds the text, counts the matches and replaces them all', async ({ page }) => {
  await openNote(page);
  // the caret at the start of the note: the first match is the one after it
  await noteEditor(page).getByText('alpha beta').click();
  await page.waitForTimeout(150); // the editor takes the selection of the click from the browser a moment later
  await page.keyboard.press('Home');
  await page.keyboard.press('ControlOrMeta+f');
  const bar = findBar(page);
  await expect(bar).toBeVisible();
  const find = bar.getByRole('textbox', { name: 'Find', exact: true });
  await expect(find).toBeFocused();
  await find.fill('alpha');
  await expect(bar.getByRole('status')).toHaveText('3 matches');
  await expect(proseMirror(page).locator('.live-find-match')).toHaveCount(3);
  await find.press('Enter');
  await expect(bar.getByRole('status')).toHaveText('1 of 3');
  await expect(proseMirror(page).locator('.live-find-current')).toHaveCount(1);
  await bar.getByRole('button', { name: 'Match case' }).click();
  // the first of the two is the one the selection is on
  await expect(bar.getByRole('status')).toHaveText('1 of 2');
  await bar.getByRole('textbox', { name: 'Replace with' }).fill('omega');
  await bar.getByRole('button', { name: 'Replace all' }).click();
  await expect.poll(file(page)).toBe('omega beta\n\nomega gamma\n\nplain Alpha\n');
});

test('Mod+F in Source opens the search panel of CodeMirror and replaces all', async ({ page }) => {
  await openSource(page);
  await source(page).getByText('alpha beta').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ControlOrMeta+f');
  const panel = page.locator('.cm-search');
  await expect(panel).toBeVisible();
  await panel.locator('input[name=search]').fill('alpha');
  await panel.locator('input[name=case]').check();
  await panel.locator('input[name=replace]').fill('omega');
  await panel.locator('button[name=replaceAll]').click();
  await expect.poll(file(page)).toBe('omega beta\n\nomega gamma\n\nplain Alpha\n');
});

test('Escape closes the search and the keyboard goes back to the note', async ({ page }) => {
  await openNote(page);
  await noteEditor(page).click();
  await page.keyboard.press('ControlOrMeta+f');
  const bar = findBar(page);
  await bar.getByRole('textbox', { name: 'Find', exact: true }).fill('beta');
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(proseMirror(page).locator('.live-find-match')).toHaveCount(0);
  await expect(proseMirror(page)).toBeFocused();
  // typing goes into the note again
  await page.keyboard.type('X');
  await expect.poll(file(page)).toContain('X');
});

test('Escape closes the search panel of Source and the keyboard goes back to the note', async ({
  page,
}) => {
  await openSource(page);
  await source(page).click();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('.cm-search')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-search')).toHaveCount(0);
  // typing goes into the note again
  await page.keyboard.type('X');
  await expect.poll(file(page)).toContain('X');
});

test('the command palette finds in the note and goes to a line', async ({ page }) => {
  await openNote(page);
  await noteEditor(page).click();
  await runCommand(page, 'Find in note');
  await expect(findBar(page).getByRole('textbox', { name: 'Find', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');

  await runCommand(page, 'toggle status bar');
  await noteEditor(page).click();
  await runCommand(page, 'Go to line');
  await expect(page.locator('#dialog-input')).toBeFocused();
  await answerPrompt(page, '5');
  await expect(page.getByRole('status', { name: 'Status bar' })).toContainText('Ln 5,');
  // the caret is in the note: what is typed goes to line 5
  await page.keyboard.type('Z');
  await expect.poll(file(page)).toBe('alpha beta\n\nalpha gamma\n\nZplain Alpha\n');
});

test('the command palette finds in the note in Source', async ({ page }) => {
  await openSource(page);
  await source(page).click();
  await runCommand(page, 'Find in note');
  await expect(page.locator('.cm-search')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-search')).toHaveCount(0);
});

test('a number past the end goes to the last line, and a cancelled prompt changes nothing', async ({
  page,
}) => {
  await openNote(page, 'one\n\ntwo\n\nthree');
  await runCommand(page, 'toggle status bar');
  await noteEditor(page).click();
  await runCommand(page, 'Go to line');
  await answerPrompt(page, '999');
  const bar = page.getByRole('status', { name: 'Status bar' });
  await expect(bar).toContainText('Ln 5,');
  await runCommand(page, 'Go to line');
  await expect(page.locator('#dialog-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(bar).toContainText('Ln 5,');
});
