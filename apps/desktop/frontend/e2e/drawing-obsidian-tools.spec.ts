// The tools of the Obsidian Excalidraw plugin: draw to shape, bucket fill and lasso selection.
import { expect, test, type Page } from '@playwright/test';
import { openDrawing, savedDrawing, scene, shape, waitSaved } from './drawingHelpers';

const canvas = (page: Page) => page.locator('.drawing-canvas .excalidraw canvas.interactive');

/** The ⋮ button at the end of the toolbar opens the menu of the extra tools. */
const openMoreTools = (page: Page) =>
  page.locator('.drawing-canvas .excalidraw').getByTitle('More tools').click();

test('the extra tools menu offers draw to shape, bucket fill and lasso selection', async ({
  page,
}) => {
  await openDrawing(page, scene([]));
  await openMoreTools(page);
  await expect(page.getByText('Draw to shape')).toBeVisible();
  await expect(page.getByText('Bucket fill')).toBeVisible();
  await expect(page.getByText('Lasso selection')).toBeVisible();
});

test('Excalidraw’s main menu button is not shown', async ({ page }) => {
  await openDrawing(page, scene([]));
  await expect(page.locator('.drawing-canvas .excalidraw .main-menu-trigger')).toBeHidden();
});

test('lasso selection selects the shapes inside the loop', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 200, 0, 100, 60)]));
  await openMoreTools(page);
  await page.getByText('Lasso selection').click();
  const box = (await canvas(page).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const loop = [
    [-220, -140],
    [220, -140],
    [220, 140],
    [-220, 140],
    [-220, -140],
  ] as const;
  await page.mouse.move(cx + loop[0][0], cy + loop[0][1]);
  await page.mouse.down();
  for (const [dx, dy] of loop.slice(1)) await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('Delete');
  await waitSaved(page);
  const els = (await savedDrawing(page)).elements;
  expect(els.filter((e) => !e['isDeleted'])).toHaveLength(0);
});
