import { expect, test, type Page } from '@playwright/test';

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    emit(name: string, payload: unknown): void;
  };
}

async function openVault(page: Page, files: Record<string, string> = {}): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await page.evaluate((seed) => {
    const w = window as unknown as MockWindow;
    const v = [...w.__mock.vaults.values()][0];
    if (!v) throw new Error('vault not open');
    for (const [p, c] of Object.entries(seed)) v.files.set(p, c);
    w.__mock.emit('vault:file-changed', { vaultId: v.info.id, paths: Object.keys(seed) });
  }, files);
}

test('sidebar tabs use a roving tabindex and arrow keys', async ({ page }) => {
  await openVault(page);
  const files = page.getByRole('tab', { name: 'Files' }).first();
  await files.focus();
  await expect(files).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowRight');
  const second = page.locator('.sidebar .tabs [role="tab"]').nth(1);
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(second).toBeFocused();
  await page.keyboard.press('Home');
  await expect(files).toHaveAttribute('aria-selected', 'true');
});

test('the file tree is a keyboard-operable tree', async ({ page }) => {
  await openVault(page, {
    'Alpha.md': '# Alpha',
    'Beta.md': '# Beta',
    'Folder/Inner.md': '# Inner',
  });
  const tree = page.getByRole('tree');
  await expect(tree.getByRole('treeitem', { name: /Alpha/ })).toBeVisible();
  const items = tree.getByRole('treeitem');
  await items.first().focus();
  // exactly one tab stop
  expect(await tree.locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  // folders expand/collapse with the arrows
  const folder = tree.getByRole('treeitem', { name: /Folder/ });
  await folder.focus();
  // a vault opens with every folder closed
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  // Enter opens a note
  const alpha = tree.getByRole('treeitem', { name: /Alpha/ });
  await alpha.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /Alpha/ })).toBeVisible();
});

test('F2 renames and the context-menu key opens a keyboard-navigable menu', async ({ page }) => {
  await openVault(page, { 'Alpha.md': '# Alpha' });
  const alpha = page.getByRole('tree').getByRole('treeitem', { name: /Alpha/ });
  await alpha.focus();
  await page.keyboard.press('ContextMenu');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const first = menu.getByRole('menuitem').first();
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await page.keyboard.press('F2');
  await expect(page.locator('#dialog-input')).toBeVisible();
  // The modal traps Tab in both directions…
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('[aria-modal="true"]')),
    ).toBe(true);
  }
  // …and gives focus back to the element that opened it.
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog-input')).toHaveCount(0);
  await expect(alpha).toBeFocused();
});

test('open tabs: arrow keys move between tabs, Delete closes', async ({ page }) => {
  await openVault(page);
  await page.keyboard.press('ControlOrMeta+n');
  const tablist = page.getByRole('tablist', { name: 'Open notes' });
  await expect(tablist.getByRole('tab').first()).toBeVisible();
  await tablist.getByRole('tab').first().focus();
  expect(await tablist.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
  await page.keyboard.press('Delete');
  await expect(tablist.getByRole('tab', { name: /Untitled/ })).toHaveCount(0);
});

test('the command palette is operated by keyboard and returns focus', async ({ page }) => {
  await openVault(page);
  await page.keyboard.press('ControlOrMeta+p');
  const input = page.getByRole('combobox', { name: 'Type a command…' });
  await expect(input).toBeFocused();
  await page.keyboard.type('settings');
  await expect(input).toHaveAttribute('aria-activedescendant', /palette-opt-0/);
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
});
