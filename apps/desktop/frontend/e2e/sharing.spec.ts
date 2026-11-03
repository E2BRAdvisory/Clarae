import { onWeb } from './support';
import { expect, test, uuid, vault, type CloudSeed } from './cloud';

// Invitations, mounts and the Config Profile on both targets: on the web the workbench runs on the
// real Go core against the REST mock of web/e2e/cloudMock.ts (the `cloud` fixture), and a mount
// opens in its own page (/vaults/<id>/open?share=<id>), as from the console.

const HOME = uuid(1);
const COMPANY = uuid(9);
const SHARE = uuid(0x5a);

test('accept an invitation, open the mount as a viewer: named after the share and read-only', async ({
  page,
  cloud,
}) => {
  const seed: CloudSeed = {
    vaults: [vault(HOME, 'Home', 'shared')],
    shares: [
      {
        id: SHARE,
        vault_id: COMPANY,
        vault_name: 'Company',
        resource_type: 'folder',
        display_name: 'Team docs',
        owner_id: uuid(0xada),
        owner_name: 'ada',
        created_at: new Date().toISOString(),
        my_permission: 'viewer',
        my_status: 'pending',
      },
    ],
    // The files of the share, as its mount sees them.
    files: { [SHARE]: { 'Plan.md': '# Plan\n\nread me' } },
  };
  await cloud.openVault(page, seed, { open: HOME });
  // The invitation shows up in the status bar and in Settings > Sharing (InvitationsList).
  await page.getByRole('button', { name: /1 invitation/ }).click();
  const invitation = page.getByRole('region', { name: 'Team docs' });
  await expect(invitation).toContainText('From ada · in Company');
  await invitation.getByRole('button', { name: 'Accept Team docs' }).click();
  await expect(page.getByText('Invitation to “Team docs” accepted.')).toBeVisible();
  if (cloud.rest)
    expect(cloud.rest.state.shares.find((s) => s.id === SHARE)?.my_status).toBe('accepted');
  await page.getByRole('button', { name: 'Open', exact: true }).click();

  // In the browser the mount has a page of its own (its guard and its marker, ADR-0045).
  if (onWeb()) await expect(page).toHaveURL(new RegExp(`/vaults/${COMPANY}/open\\?share=${SHARE}`));
  await expect(page.locator('.titlebar .title')).toHaveText('Team docs', { timeout: 90_000 });
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
  // Nothing was sent to the share.
  if (cloud.rest) expect(cloud.rest.calls).not.toContain('POST commit');
});

test('an administrator locks a setting: it is disabled and says so', async ({ page, cloud }) => {
  const config = {
    config: { editor: { fontSize: 20 }, features: { drawings: false } },
    locked_keys: ['editor.fontSize'],
  };
  await cloud.openVault(page, { vaults: [vault(HOME, 'Home', 'shared')], config }, { open: HOME });
  if (!onWeb()) {
    // The mock pushes the configuration the core would fetch from the cloud.
    await page.evaluate(
      (c) =>
        (
          window as unknown as { __mock: { emit(name: string, payload: unknown): void } }
        ).__mock.emit('config:updated', {
          version: 2,
          config: c.config,
          lockedKeys: c.locked_keys,
          managed: true,
          fetchedAt: '',
          features: { drawings: false },
        }),
      config,
    );
  }
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
