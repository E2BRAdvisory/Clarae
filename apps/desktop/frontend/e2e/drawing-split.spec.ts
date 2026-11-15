// The same drawing open in two panes: each pane has its own editor. Commands act on the one in
// focus, the Slideshow tab outlives the closing of either, and the two stay in step through the
// file without a conflict.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support';
import {
  openDrawing,
  runCommand,
  savedDrawing,
  scene,
  shape,
  watchNetwork,
} from './drawingHelpers';

// Offline gate: nothing here may reach outside the app itself.
let external: string[] = [];
test.beforeEach(({ page }) => {
  external = watchNetwork(page);
});
test.afterEach(() => {
  expect(external).toEqual([]);
});

const solid = { backgroundColor: '#1e1e1e', fillStyle: 'solid' };
const pane = (page: Page, i: number): Locator => page.locator('.pane').nth(i);
const canvasOf = (p: Locator): Locator => p.locator('.excalidraw canvas.interactive');
const zoomOf = async (p: Locator): Promise<number> =>
  parseInt((await p.getByRole('button', { name: 'Reset zoom' }).innerText()) || '0', 10);

/** Splits the pane of the open drawing: the same drawing shows in both, the new pane in focus. */
async function split(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+\\');
  await expect(page.locator('.pane')).toHaveCount(2);
  for (const i of [0, 1]) await expect(canvasOf(pane(page, i))).toBeVisible({ timeout: 60_000 });
}

/** Puts the focus in a pane without changing its drawing (an empty corner of the canvas). */
async function focus(p: Locator): Promise<void> {
  const box = (await canvasOf(p).boundingBox())!;
  await p.page().mouse.click(box.x + box.width - 6, box.y + box.height - 6);
  await expect(p).toHaveClass(/focused/);
}

test('a command acts on the editor of the pane in focus', async ({ page }) => {
  // Taller than any pane: fitting it lowers the zoom of the editor that does it.
  await openDrawing(page, scene([shape('tall', 0, 0, 200, 4000, solid)]));
  await split(page);
  expect(await zoomOf(pane(page, 0))).toBe(100);
  expect(await zoomOf(pane(page, 1))).toBe(100);

  // The first pane's editor registered first: only the focus says it is the one meant.
  await focus(pane(page, 0));
  await runCommand(page, 'zoom to fit the selection');
  await expect.poll(() => zoomOf(pane(page, 0))).toBeLessThan(100);
  expect(await zoomOf(pane(page, 1))).toBe(100);

  await focus(pane(page, 1));
  await runCommand(page, 'zoom to fit the selection');
  await expect.poll(() => zoomOf(pane(page, 1))).toBeLessThan(100);
});

test('the Slideshow tab shows the frames of the pane in focus when the other leaves the drawing', async ({
  page,
}) => {
  await openDrawing(
    page,
    scene([
      shape('f1', 0, 0, 400, 300, { name: 'Intro' }, 'frame'),
      shape('f2', 500, 0, 400, 300, { name: 'Details' }, 'frame'),
    ]),
    { files: { 'Note.md': '# Note' } },
  );
  await page.getByRole('button', { name: 'Toggle right sidebar' }).click();
  await page.getByRole('tab', { name: 'Slides' }).click();
  const summary = page.getByText('Frame slideshow · 2 of 2 included');
  await expect(summary).toBeVisible();
  await split(page);
  await expect(summary).toBeVisible();

  // The pane in focus moves on to a note: its editor of the drawing goes away.
  await page.locator('.tree .node', { hasText: 'Note' }).click();
  await expect(pane(page, 1).locator('.excalidraw')).toHaveCount(0);
  await expect(summary).toHaveCount(0);

  // Back on the pane that still shows the drawing: its frames are in the tab, and the tab drives
  // that editor.
  await focus(pane(page, 0));
  await expect(summary).toBeVisible();
  await expect(page.locator('.slide-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Start presentation' }).click();
  await expect(page.locator('.slideshow-bar')).toContainText('1 / 2');
});

test('closing one of the two panes leaves the drawing and its frames in the other', async ({
  page,
}) => {
  await openDrawing(
    page,
    scene([
      shape('f1', 0, 0, 400, 300, { name: 'Intro' }, 'frame'),
      shape('f2', 500, 0, 400, 300, { name: 'Details' }, 'frame'),
    ]),
  );
  await page.getByRole('button', { name: 'Toggle right sidebar' }).click();
  await page.getByRole('tab', { name: 'Slides' }).click();
  const summary = page.getByText('Frame slideshow · 2 of 2 included');
  await split(page);
  await runCommand(page, 'close pane');
  await expect(page.locator('.pane')).toHaveCount(1);
  await expect(canvasOf(pane(page, 0))).toBeVisible();
  await expect(summary).toBeVisible();
  await expect(page.locator('.slide-card')).toHaveCount(2);
});

test('an edit in one pane reaches the other through the file, without a conflict', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  await split(page);
  await page.getByRole('button', { name: 'Toggle right sidebar' }).click();
  await page.getByRole('tab', { name: 'Slides' }).click();

  // A rectangle drawn in the pane in focus (the second one).
  const box = (await canvasOf(pane(page, 1)).boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 60, box.y + 260);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 330, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await savedDrawing(page)).elements.filter((e) => !e['isDeleted']).length, {
      timeout: 15_000,
    })
    .toBe(2);

  // Both editors hold the file as saved: nothing more to write, nothing to choose.
  await page.waitForTimeout(3500);
  for (const i of [0, 1]) {
    await expect(pane(page, i).locator('.save-state')).toHaveText('Saved');
    await expect(pane(page, i).locator('.banner[role="alert"]')).toHaveCount(0);
  }
  expect((await savedDrawing(page)).elements.filter((e) => !e['isDeleted'])).toHaveLength(2);
});
