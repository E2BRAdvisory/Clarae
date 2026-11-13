import { onWeb, openVault } from './support';
import { expect, test, uuid, vault } from './cloud';

// Collaboration on the Live editor is off (ADR-0050, A-W7): a profile with `collab: true` loads no code
// for it, because it also takes a build made for it and a registered provider, and no provider is in the
// build. It runs on both targets (desktop-mock, web-core), and, to show that the flag and the build constant
// together still open nothing, with CLARAE_COLLAB=1.
const HOME = uuid(1);

test('a profile with collab: true does not load the collaboration chunk', async ({
  page,
  cloud,
}) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  // `drawings: false` is there to show that this profile is the one in force: it has an effect we can see
  const features = { collab: true, drawings: false };
  const files = { 'Note.md': '# Hello\n\nbody of the note\n' };
  if (onWeb()) {
    // the profile comes from the cloud, as in a managed vault
    await cloud.openVault(
      page,
      { vaults: [vault(HOME, 'Home', 'shared')], config: { config: { features } } },
      { open: HOME, files },
    );
  } else {
    await openVault(page, files);
  }
  if (!onWeb()) {
    // The mock pushes the configuration the core would fetch from the cloud.
    await page.evaluate(
      (f) =>
        (
          window as unknown as { __mock: { emit(name: string, payload: unknown): void } }
        ).__mock.emit('config:updated', {
          version: 2,
          config: { features: f },
          lockedKeys: [],
          managed: true,
          fetchedAt: '',
          features: f,
        }),
      features,
    );
  }
  await page.locator('.tree .node', { hasText: 'Note' }).first().click();
  const editor = page.locator('.live-host .ProseMirror');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('body of the note');

  // the editor works, and the profile is in force
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await expect(editor).toContainText('body of the note and more');
  await page.locator('.tree').click({ button: 'right', position: { x: 20, y: 200 } });
  await expect(page.getByRole('menuitem', { name: 'New note' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'New drawing' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // the Live editor was loaded (so the pattern below means something), and nothing of collaboration
  expect(requested.some((p) => /\/MilkdownEditor-[A-Z0-9]+\.js$/.test(p))).toBe(true);
  expect(requested.filter((p) => /\/collab-[A-Z0-9]+\.js$/.test(p))).toEqual([]);
});
