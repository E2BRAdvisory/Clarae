import { expect, test, type Page } from '@playwright/test';

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    emit(name: string, payload: unknown): void;
  };
}

/** Opens the (mock) vault from the welcome screen; optionally seeds notes first. */
async function openVault(page: Page, files: Record<string, string> = {}): Promise<void> {
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

test('create notes, link them, see the backlink, rename with link update', async ({ page }) => {
  await openVault(page);

  // First note, written in the editor.
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.getByRole('tab', { name: /Untitled/ })).toBeVisible();
  const editor = page.getByLabel('Note editor');
  await editor.click();
  await editor.fill('Hello [[Second]]');
  await expect(page.locator('.save-state')).toHaveText('Saved');

  // Second note, created from the quick switcher.
  await page.keyboard.press('ControlOrMeta+o');
  await page.getByPlaceholder('Find or create a note…').fill('Second');
  await page.getByText('Create "Second"').click();
  await expect(page.getByRole('tab', { name: /Second/ })).toBeVisible();

  // Backlinks of Second list Untitled.
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByPlaceholder('Type a command…').fill('backlinks');
  await page.keyboard.press('Enter');
  await expect(page.locator('.backlinks .item', { hasText: 'Untitled' })).toBeVisible();

  // Rename Second: the link in Untitled is rewritten.
  await page.locator('.tree .node', { hasText: 'Second' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.locator('#dialog-input').fill('Renamed.md');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'OK' }).click(); // "1 link(s) in 1 note(s) will be updated"
  await expect(page.locator('.tree .node', { hasText: 'Renamed' })).toBeVisible();

  // Opening a note replaces the active tab, so Untitled is reopened from the tree.
  await page.locator('.tree .node', { hasText: 'Untitled' }).click();
  await expect(page.getByLabel('Note editor')).toContainText('Renamed');
});

test('search finds notes and opens them', async ({ page }) => {
  await openVault(page, {
    'Alpha.md': '# Alpha\nthe quick brown fox',
    'Beta.md': '# Beta\nlazy dog',
  });
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await page.getByPlaceholder(/Search…/).fill('fox');
  await page.locator('.hit', { hasText: 'Alpha' }).click();
  await expect(page.getByRole('tab', { name: /Alpha/ })).toBeVisible();
  await expect(page.locator('.hit', { hasText: 'Beta' })).toHaveCount(0);
});

test('a note switches between Live Preview, Source and Reading', async ({ page }) => {
  await openVault(page, { 'Home.md': '# Home\nSee [[Other]] and **bold**', 'Other.md': '# Other' });
  await page.locator('.tree .node', { hasText: 'Home' }).click();
  const editor = page.getByLabel('Note editor');

  // Live Preview hides the syntax of lines you are not on.
  await expect(editor).toContainText('bold');
  await page.getByRole('button', { name: 'Source' }).click();
  await expect(editor).toContainText('**bold**');

  await page.getByRole('button', { name: 'Reading' }).click();
  await expect(page.locator('.reading a.wikilink', { hasText: 'Other' })).toBeVisible();
  await page.locator('.reading a.wikilink', { hasText: 'Other' }).click();
  await expect(page.getByRole('tab', { name: /Other/ })).toBeVisible();
});

test('split panes and the command palette', async ({ page }) => {
  await openVault(page, { 'One.md': '# One', 'Two.md': '# Two' });
  await page.locator('.tree .node', { hasText: 'One' }).click();
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(page.locator('.pane')).toHaveCount(2);
  await page.locator('.pane.focused .editor-empty, .pane.focused').first().click();
  await page.locator('.tree .node', { hasText: 'Two' }).click();
  await expect(page.getByRole('tab', { name: /Two/ })).toBeVisible();
});
