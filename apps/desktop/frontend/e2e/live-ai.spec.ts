import { onWeb, openVault } from './support';
import { expect, test, uuid, vault } from './cloud';

// The AI assistant on the Live editor is off (ADR-0050, A-W6): a profile with `ai: true` loads no code for
// it, because it also takes a build made for it (`MEMOBRAIN_AI=1`), the capability, a vault that is not
// private and a core that says `Status` is available. In a normal build no gate but the flag is open, and
// the chunk of the assistant is never requested, whatever the profile says. It runs on both targets
// (desktop-mock, web-core) in a build with the engine switch on:
//   MEMOBRAIN_LIVE_ENGINE=milkdown yarn workspace @memobrain/web run e2e:workbench-ui e2e/live-ai.spec.ts
test.skip(
  process.env['MEMOBRAIN_LIVE_ENGINE'] !== 'milkdown',
  'needs a build with the Milkdown Live editor (MEMOBRAIN_LIVE_ENGINE=milkdown)',
);

const HOME = uuid(1);

test('a profile with ai: true does not load the AI chunk in a normal build', async ({
  page,
  cloud,
}) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  // `drawings: false` is there to show that this profile is the one in force: it has an effect we can see
  const features = { ai: true, drawings: false };
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

  // the Live editor was loaded (so the pattern below means something), and nothing of the assistant
  expect(requested.some((p) => /\/MilkdownEditor-[A-Z0-9]+\.js$/.test(p))).toBe(true);
  expect(requested.filter((p) => /\/ai-[A-Z0-9]+\.js$/.test(p))).toEqual([]);
});
