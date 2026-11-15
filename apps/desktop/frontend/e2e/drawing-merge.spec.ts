// Unsaved edits of a drawing and a newer version of its file: the core merges them (the rules of
// the sync), so the user is asked to choose only when it does not — another user's change on a
// shared vault — and can then keep both.
import type { Locator, Page } from '@playwright/test';
import { expect, listVaultFiles, readVaultFile, seedVault, skipOnWeb, test } from './support';
import {
  openDrawing,
  savedDrawing,
  scene,
  shape,
  waitSaved,
  watchNetwork,
  type MockWindow,
} from './drawingHelpers';

// Offline gate: nothing here may reach outside the app itself.
let external: string[] = [];
test.beforeEach(({ page }) => {
  external = watchNetwork(page);
});
test.afterEach(() => {
  expect(external).toEqual([]);
});

const pane = (page: Page, i: number): Locator => page.locator('.pane').nth(i);
const canvasOf = (scope: Locator | Page): Locator =>
  scope.locator('.excalidraw canvas.interactive');
const conflict = (scope: Locator | Page): Locator => scope.locator('.banner[role="alert"]');
const live = async (page: Page): Promise<string[]> =>
  (await savedDrawing(page)).elements.filter((e) => !e['isDeleted']).map((e) => e.id);

/** Draws a rectangle in the canvas of `scope`, at an offset from its top left corner. */
async function drawRectangle(scope: Locator | Page, page: Page, x: number, y: number) {
  const box = (await canvasOf(scope).boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
  await page.keyboard.press('r');
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 90, box.y + y + 60, { steps: 6 });
  await page.mouse.up();
}

test('unsaved edits and a change of the file from outside are both kept', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  await drawRectangle(page, page, 420, 320);
  // Before the autosave of that rectangle: somebody else adds a shape to the file.
  await seedVault(page, {
    files: {
      'Board.excalidraw': scene([shape('a', 0, 0, 100, 60), shape('theirs', 900, 0, 80, 80)]),
    },
  });

  await expect.poll(() => live(page), { timeout: 15_000 }).toHaveLength(3);
  expect(await live(page)).toEqual(expect.arrayContaining(['a', 'theirs']));
  await waitSaved(page);
  await expect(conflict(page)).toHaveCount(0);

  // The merged drawing is the one on screen: the next edit builds on it and saves cleanly.
  await drawRectangle(page, page, 420, 420);
  await expect.poll(() => live(page), { timeout: 15_000 }).toHaveLength(4);
  await expect(conflict(page)).toHaveCount(0);
});

test('two panes on a drawing edited at the same time converge without a conflict', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(page.locator('.pane')).toHaveCount(2);
  for (const i of [0, 1]) await expect(canvasOf(pane(page, i))).toBeVisible({ timeout: 60_000 });

  // A rectangle in each pane, the second one before the first is saved.
  await drawRectangle(pane(page, 1), page, 60, 260);
  await drawRectangle(pane(page, 0), page, 60, 360);

  await expect.poll(() => live(page), { timeout: 20_000 }).toHaveLength(3);
  for (const i of [0, 1]) {
    await expect(pane(page, i).locator('.save-state')).toHaveText('Saved', { timeout: 15_000 });
    await expect(conflict(pane(page, i))).toHaveCount(0);
  }
  // Nothing is written back and forth afterwards.
  const settled = await readVaultFile(page, 'Board.excalidraw');
  await page.waitForTimeout(3500);
  expect(await readVaultFile(page, 'Board.excalidraw')).toBe(settled);
});

test("another user's change is not merged: the choice is the user's, and both can be kept", async ({
  page,
}) => {
  skipOnWeb(
    'drawing.edit',
    'the spec makes the Wails mock answer as for a change by another user of a shared vault (window.__mock.mergeSameAuthor); a vault opened in the browser without a cloud has one author',
  );
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  await page.evaluate(() => {
    (window as unknown as MockWindow).__mock.mergeSameAuthor = false;
  });
  await drawRectangle(page, page, 420, 320);
  const theirs = scene([shape('a', 0, 0, 100, 60), shape('theirs', 900, 0, 80, 80)]);
  await seedVault(page, { files: { 'Board.excalidraw': theirs } });

  const banner = conflict(page);
  await expect(banner).toBeVisible();
  for (const name of ['Reload', 'Overwrite', 'Keep both'])
    await expect(banner.getByRole('button', { name })).toBeVisible();
  // Nothing was written over the other user's version meanwhile.
  await page.waitForTimeout(3000);
  expect(await readVaultFile(page, 'Board.excalidraw')).toBe(theirs);

  await banner.getByRole('button', { name: 'Keep both' }).click();
  const told = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(told).toContainText('Both versions kept');
  await page.keyboard.press('Enter');
  await expect(banner).toHaveCount(0);

  // The file is theirs; the rectangle drawn here is in a copy next to it.
  expect(await readVaultFile(page, 'Board.excalidraw')).toBe(theirs);
  const copies = (await listVaultFiles(page)).filter(
    (p) => p !== 'Board.excalidraw' && p.endsWith('.excalidraw'),
  );
  expect(copies).toHaveLength(1);
  const copy = JSON.parse(await readVaultFile(page, copies[0]!)) as { elements: { id: string }[] };
  expect(copy.elements.map((e) => e.id)).not.toContain('theirs');
  expect(copy.elements).toHaveLength(2);
});
