import { expect, test, type Page } from '@playwright/test';

interface MockWindow {
  __mock: {
    sharing: { invitations: unknown[]; mountFiles: Map<string, Record<string, string>> };
    config: Record<string, unknown>;
    emit(name: string, payload: unknown): void;
  };
}

async function openVault(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
}

test('accept an invitation, open the mount as a viewer: named after the share and read-only', async ({
  page,
}) => {
  await openVault(page);
  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    w.__mock.sharing.invitations.push({
      id: 'sh-1',
      vaultId: 'cloud-1',
      vaultName: 'Company',
      resourceType: 'folder',
      pathPrefix: '',
      displayName: 'Team docs',
      ownerName: 'ada',
      createdAt: new Date().toISOString(),
      expiresAt: '',
      myPermission: 'viewer',
      myStatus: 'pending',
      grants: [],
    });
    w.__mock.sharing.mountFiles.set('sh-1', { 'Plan.md': '# Plan\n\nread me' });
    w.__mock.emit('shares:changed', { shareId: 'sh-1', kind: 'granted' });
  });
  // The invitation shows up in the status bar and in Settings > Sharing.
  await page.getByRole('button', { name: /1 invitation/ }).click();
  await expect(page.getByText('Shared by ada')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.getByRole('button', { name: 'Open' }).click();

  await expect(page.locator('.titlebar .title')).toHaveText('Team docs');
  await expect(page.locator('.vault-status .badge.permission')).toHaveText('Viewer · read-only');
  await page.locator('.tree .node', { hasText: 'Plan' }).click();
  // Read-only: the editor refuses typing and the explorer offers no way to create anything.
  const editor = page.getByLabel('Note editor');
  await expect(editor).toContainText('read me');
  await editor.click();
  await page.keyboard.type('vandalism');
  await expect(editor).not.toContainText('vandalism');
  // The ribbon button is off on a read-only vault.
  await expect(
    page
      .getByRole('navigation', { name: 'Quick actions' })
      .getByRole('button', { name: 'New note' }),
  ).toBeDisabled();
});

test('an administrator locks a setting: it is disabled and says so', async ({ page }) => {
  await openVault(page);
  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    w.__mock.emit('config:updated', {
      version: 2,
      config: { editor: { fontSize: 20 } },
      lockedKeys: ['editor.fontSize'],
      managed: true,
      fetchedAt: '',
      features: { drawings: false },
    });
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Editor', exact: true }).click();
  await expect(page.getByLabel('Editor font size')).toBeDisabled();
  await expect(page.getByLabel('Editor font size')).toHaveValue('20');
  await expect(page.getByText(/Managed by your administrator/)).toBeVisible();
  await expect(page.getByLabel('Wrap long lines')).toBeEnabled();
  // A disabled feature disappears from the explorer menu.
  await page.keyboard.press('Escape');
  await page.locator('.tree').click({ button: 'right', position: { x: 20, y: 200 } });
  await expect(page.getByRole('menuitem', { name: 'New note' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'New drawing' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'New canvas' })).toBeVisible();
});
