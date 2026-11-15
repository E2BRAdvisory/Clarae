// Getting around a drawing: the two buttons next to Excalidraw's zoom control (zoom to the
// selection, mini-map) and the mini-map itself.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support';
import { openDrawing, runCommand, scene, shape, watchNetwork } from './drawingHelpers';

// Offline gate: nothing here may reach outside the app itself.
let external: string[] = [];
test.beforeEach(({ page }) => {
  external = watchNetwork(page);
});
test.afterEach(() => {
  expect(external).toEqual([]);
});

const solid = { backgroundColor: '#1e1e1e', fillStyle: 'solid' };
const tools = (page: Page): Locator => page.getByRole('group', { name: 'View', exact: true });
const zoomButton = (page: Page): Locator => tools(page).getByRole('button').first();
const mapButton = (page: Page): Locator => tools(page).getByRole('button', { name: 'Mini-map' });
const minimap = (page: Page): Locator => page.locator('.drawing-minimap');
const viewFrame = (page: Page): Locator => page.locator('.drawing-minimap-view');
/** The button of Excalidraw's tray that opens the styles of the selection. */
const styleMenu = (page: Page): Locator =>
  page.locator('.excalidraw .App-toolbar-content').getByRole('button', { name: 'Edit' });
const canvas = (page: Page): Locator =>
  page.locator('.drawing-canvas .excalidraw canvas.interactive');
/** Excalidraw's own zoom readout ("100%"). */
const zoom = async (page: Page): Promise<number> =>
  parseInt(
    (await page.locator('.excalidraw').getByRole('button', { name: 'Reset zoom' }).innerText()) ||
      '0',
    10,
  );

/** The zoom once the animated move is over (two equal readings in a row). */
async function settledZoom(page: Page): Promise<number> {
  let last = -1;
  await expect
    .poll(async () => {
      const now = await zoom(page);
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
  return last;
}

const centre = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};

/** The rows of the canvas that hold something darker than the background, in page pixels. */
const paintedRows = (page: Page): Promise<{ top: number; bottom: number }> =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.drawing-canvas canvas.static')!;
    const rect = c.getBoundingClientRect();
    const { data, width, height } = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x += 4) {
        if (data[(y * width + x) * 4]! < 128) {
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
    }
    const k = rect.height / height;
    return { top: rect.top + top * k, bottom: rect.top + bottom * k };
  });

test('the navigation buttons sit right of the zoom control and name what they will show', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60, solid), shape('b', 140, 0, 100, 60)]));
  await expect(tools(page)).toBeVisible();
  const zoomIsland = (await page.locator('.excalidraw .zoom-actions').boundingBox())!;
  const group = (await tools(page).boundingBox())!;
  expect(group.x).toBeGreaterThanOrEqual(zoomIsland.x + zoomIsland.width);
  expect(group.x - (zoomIsland.x + zoomIsland.width)).toBeLessThan(24);
  expect(
    Math.abs(group.y + group.height / 2 - (zoomIsland.y + zoomIsland.height / 2)),
  ).toBeLessThan(6);

  // Nothing selected: the whole drawing. With a selection: the selection.
  await expect(zoomButton(page)).toHaveAccessibleName('Zoom to the whole drawing');
  const at = await centre(canvas(page));
  await page.mouse.click(at.x - 70, at.y); // inside the filled rectangle "a"
  await expect(zoomButton(page)).toHaveAccessibleName('Zoom to the selection');
  // The island of the toolbar grew with the selection: the group moved with it.
  const moved = (await page.locator('.excalidraw .zoom-actions').boundingBox())!;
  await expect
    .poll(async () => (await tools(page).boundingBox())!.x)
    .toBeGreaterThanOrEqual(moved.x + moved.width);

  await zoomButton(page).click();
  await expect.poll(() => zoom(page)).toBeGreaterThan(100);
  const onSelection = await settledZoom(page);

  // Without a selection the same button fits everything: less zoom than for one shape.
  await page.keyboard.press('Escape');
  await expect(zoomButton(page)).toHaveAccessibleName('Zoom to the whole drawing');
  await zoomButton(page).click();
  await expect.poll(() => zoom(page)).not.toBe(onSelection);
  expect(await settledZoom(page)).toBeLessThan(onSelection);
});

test('zoom fits the drawing in what the toolbar and the bottom bar leave free', async ({
  page,
}) => {
  // Taller than any window: fitting it is a matter of height.
  await openDrawing(page, scene([shape('tall', 0, 0, 200, 4000, solid)]));
  await zoomButton(page).click();
  await expect.poll(() => zoom(page)).toBeLessThan(100);
  await page.waitForTimeout(600); // the move is animated
  const rows = await paintedRows(page);
  const toolbar = (await page.locator('.excalidraw .App-toolbar').first().boundingBox())!;
  const bar = (await page.locator('.excalidraw .zoom-actions').boundingBox())!;
  expect(rows.top).toBeGreaterThanOrEqual(toolbar.y + toolbar.height - 1);
  expect(rows.bottom).toBeLessThanOrEqual(bar.y + 1);
});

test('the command works on a drawing that may not be changed', async ({ page }) => {
  await openDrawing(page, scene([shape('tall', 0, 0, 200, 4000, solid)]));
  await page.getByRole('button', { name: 'View only' }).click();
  await expect(tools(page)).toBeVisible();
  await runCommand(page, 'zoom to fit the selection');
  await expect.poll(() => zoom(page)).toBeLessThan(100);
});

test('the mini-map shows on request, stays on, and moves the view', async ({ page }) => {
  const drawing = scene([
    shape('a', 0, 0, 200, 120, solid),
    shape('b', 3000, 0, 200, 120, solid),
    shape('c', 0, 2000, 200, 120, solid),
    shape('d', 3000, 2000, 200, 120, solid),
  ]);
  await openDrawing(page, drawing);
  await expect(minimap(page)).toHaveCount(0);
  await expect(mapButton(page)).toHaveAttribute('aria-pressed', 'false');
  await mapButton(page).click();
  await expect(minimap(page)).toBeVisible();
  await expect(mapButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(viewFrame(page)).toBeVisible();

  // It sits above the bottom bar, clear of it.
  const map = (await minimap(page).boundingBox())!;
  const bar = (await page.locator('.excalidraw .zoom-actions').boundingBox())!;
  expect(map.y + map.height).toBeLessThanOrEqual(bar.y);

  // A click moves the view there: the frame of the view follows, the zoom stays.
  const before = await centre(viewFrame(page));
  const zoomBefore = await zoom(page);
  await page.mouse.click(map.x + map.width - 30, map.y + map.height - 30);
  await expect
    .poll(async () => {
      const now = await centre(viewFrame(page));
      return Math.hypot(now.x - before.x, now.y - before.y);
    })
    .toBeGreaterThan(20);
  expect(await zoom(page)).toBe(zoomBefore);

  // So does a drag, and the arrow keys once the mini-map has the focus.
  const start = await centre(viewFrame(page));
  await page.mouse.move(map.x + map.width - 30, map.y + map.height - 30);
  await page.mouse.down();
  await page.mouse.move(map.x + 40, map.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const now = await centre(viewFrame(page));
      return Math.hypot(now.x - start.x, now.y - start.y);
    })
    .toBeGreaterThan(20);
  const beforeKeys = await centre(viewFrame(page));
  await minimap(page).focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await centre(viewFrame(page))).x).toBeGreaterThan(beforeKeys.x);

  // Zen and the presentation take everything off the canvas, the mini-map included.
  await page.getByRole('button', { name: 'Zen' }).click();
  await expect(minimap(page)).toHaveCount(0);
  await expect(tools(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Zen' }).click();
  await expect(minimap(page)).toBeVisible();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await expect(minimap(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(minimap(page)).toBeVisible();

  // The choice belongs to this device: it is still on after a restart, on any drawing.
  await page.reload();
  await openDrawing(page, drawing);
  await expect(minimap(page)).toBeVisible();
  await runCommand(page, 'show or hide the mini-map');
  await expect(minimap(page)).toHaveCount(0);
});

test('the mini-map of an empty drawing says so, and gives way to the style menu', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await openDrawing(page, scene([]));
  await mapButton(page).click();
  await expect(minimap(page)).toContainText('The drawing is empty');

  // Draw something and open Excalidraw's style menu, which rises from the same corner.
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6); // empty corner: focus
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 500, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 620, box.y + 290, { steps: 5 });
  await page.mouse.up();
  await expect(minimap(page)).not.toContainText('The drawing is empty');
  await styleMenu(page).click();
  await expect(page.locator('.excalidraw .App-tray-menu')).toBeVisible();
  await expect(minimap(page)).toBeHidden();
  await styleMenu(page).click();
  await expect(minimap(page)).toBeVisible();
});
