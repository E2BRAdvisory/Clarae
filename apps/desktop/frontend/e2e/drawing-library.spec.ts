// The shape library of a vault (.clarae/excalidraw-library.json) in the drawing editor: read
// without being rewritten, followed when the file changes, and one for every pane.
import type { Locator, Page } from '@playwright/test';
import { expect, onWeb, openVault, readVaultFile, seedVault, test } from './support';
import { runCommand, scene, shape, watchNetwork, type El } from './drawingHelpers';

// Offline gate: nothing here may reach outside the app itself.
let external: string[] = [];
test.beforeEach(({ page }) => {
  external = watchNetwork(page);
});
test.afterEach(() => {
  expect(external).toEqual([]);
});

const LIBRARY = '.clarae/excalidraw-library.json';
const item = (id: string, el: El) => ({ id, status: 'unpublished', created: 1, elements: [el] });
const libraryOf = (items: unknown[]): string =>
  JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: items });
const SQUARE = item('square', shape('sq', 0, 0, 50, 50));
const ROUND = item('round', shape('ro', 0, 0, 80, 40, {}, 'ellipse'));
const DIAMOND = item('diamond', shape('di', 0, 0, 60, 60, {}, 'diamond'));

/**
 * Writes the library file as something outside the editors does (the sync, another device). On
 * the desktop mock the vault reports the change; in the browser the window coming back in front
 * is what makes the app look at the file again.
 */
async function writeLibrary(page: Page, items: unknown[]): Promise<void> {
  const body = libraryOf(items);
  if (!onWeb()) return seedVault(page, { files: { [LIBRARY]: body } });
  await page.evaluate(async (text) => {
    type Call = (...args: unknown[]) => Promise<unknown>;
    const app = (window as unknown as { go: { app: Record<string, Record<string, Call>> } }).go.app;
    const vault = ((await app['VaultAPI']!['ListOpen']!()) as { id: string }[])[0];
    await app['VaultAPI']!['WriteConfig']!(vault!.id, 'excalidraw-library.json', text);
    window.dispatchEvent(new Event('focus'));
  }, body);
}

const idsOnDisk = async (page: Page): Promise<string[]> =>
  (
    (
      JSON.parse((await readVaultFile(page, LIBRARY)) || '{}') as {
        libraryItems?: { id: string }[];
      }
    ).libraryItems ?? []
  ).map((i) => i.id);

const pane = (page: Page, i: number): Locator => page.locator('.pane').nth(i);
const canvasOf = (scope: Locator | Page): Locator =>
  scope.locator('.excalidraw canvas.interactive');
/** The shapes shown in the library panel of an editor. */
const shapesIn = (scope: Locator | Page): Locator =>
  scope.locator('.excalidraw .library-unit__active');

async function openLibraryPanel(scope: Locator | Page): Promise<void> {
  await scope
    .locator('.excalidraw .sidebar-trigger, .excalidraw .default-sidebar-trigger')
    .first()
    .click();
}

/** A vault with a drawing and a library already in it, the drawing open in a tab. */
async function openWithLibrary(page: Page, items: unknown[]): Promise<void> {
  await openVault(page, { 'Board.excalidraw': scene([shape('a', 0, 0, 100, 60)]) });
  await writeLibrary(page, items);
  await page.locator('.tree .node', { hasText: 'Board' }).click();
  await expect(canvasOf(page)).toBeVisible({ timeout: 60_000 });
}

test('the library of the vault is in the editor, and opening a drawing does not rewrite it', async ({
  page,
}) => {
  await openWithLibrary(page, [SQUARE, ROUND]);
  const written = await readVaultFile(page, LIBRARY);
  await openLibraryPanel(page);
  await expect(shapesIn(page)).toHaveCount(2);
  // Excalidraw reports the library it was given: that is not a change to write.
  await page.waitForTimeout(2500);
  expect(await readVaultFile(page, LIBRARY)).toBe(written);
});

test('a library changed from outside reaches the open editor', async ({ page }) => {
  await openWithLibrary(page, [SQUARE]);
  await openLibraryPanel(page);
  await expect(shapesIn(page)).toHaveCount(1);

  await writeLibrary(page, [SQUARE, ROUND, DIAMOND]);
  await expect(shapesIn(page)).toHaveCount(3);
  // Taking it over is not a change of this editor's: the file stays as it was written.
  await page.waitForTimeout(2000);
  expect(await idsOnDisk(page)).toEqual(['square', 'round', 'diamond']);

  // A shape removed elsewhere goes from the panel too.
  await writeLibrary(page, [ROUND]);
  await expect(shapesIn(page)).toHaveCount(1);
});

test('the two panes of a split share the library: a shape added in one shows in the other', async ({
  page,
}) => {
  const more = libraryOf([DIAMOND]);
  await openVault(
    page,
    { 'Board.excalidraw': scene([shape('a', 0, 0, 100, 60)]) },
    { 'Shapes.excalidrawlib': Buffer.from(more).toString('base64') },
  );
  await writeLibrary(page, [SQUARE]);
  await page.locator('.tree .node', { hasText: 'Board' }).click();
  await expect(canvasOf(page)).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(page.locator('.pane')).toHaveCount(2);
  for (const i of [0, 1]) await expect(canvasOf(pane(page, i))).toBeVisible({ timeout: 60_000 });
  await openLibraryPanel(pane(page, 0));
  await expect(shapesIn(pane(page, 0))).toHaveCount(1);

  // Imported in the pane in focus (the second one)…
  await runCommand(page, 'import a shape library');
  await page
    .getByRole('listbox', { name: 'Import a shape library' })
    .getByRole('button', { name: 'Shapes.excalidrawlib' })
    .click();
  await expect(page.getByText('1 shapes imported into the library.')).toBeVisible();
  await page.keyboard.press('Enter');

  // …it is in the panel of the first one, and in the file once.
  await expect(shapesIn(pane(page, 0))).toHaveCount(2);
  await expect.poll(async () => (await idsOnDisk(page)).sort()).toEqual(['diamond', 'square']);
  await page.waitForTimeout(2000);
  expect((await idsOnDisk(page)).sort()).toEqual(['diamond', 'square']);
});
