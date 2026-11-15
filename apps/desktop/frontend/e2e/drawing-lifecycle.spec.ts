// The life of an open drawing next to its file: a change from outside is shown and not written
// back, a file that stops being a drawing is never overwritten, and undo steps are the user's.
import { expect, seedVault, test } from './support';
import {
  answerPrompt,
  openDrawing,
  runCommand,
  savedDrawing,
  scene,
  selectAll,
  shape,
  waitSaved,
  watchNetwork,
  type El,
} from './drawingHelpers';
import { readVaultFile } from './support';
import type { Page } from '@playwright/test';

// Offline gate: nothing here may reach outside the app itself.
let external: string[] = [];
test.beforeEach(({ page }) => {
  external = watchNetwork(page);
});
test.afterEach(() => {
  expect(external).toEqual([]);
});

const frame = (id: string, x: number, name: string): El =>
  shape(id, x, 0, 300, 200, { name }, 'frame');

const withBackground = (elements: El[], viewBackgroundColor: string): string =>
  JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'clarae',
    elements,
    appState: { viewBackgroundColor },
    files: {},
  });

/** The colour Excalidraw painted in a corner of the drawing (its background). */
const cornerColor = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.drawing-canvas canvas.static')!;
    const px = canvas.getContext('2d')!.getImageData(canvas.width - 4, canvas.height - 4, 1, 1);
    return [...px.data].slice(0, 3);
  });

const file = (page: Page): Promise<string> => readVaultFile(page, 'Board.excalidraw');
const conflict = (page: Page) => page.locator('.drawing-view .banner[role="alert"]');
const undo = (page: Page) => page.locator('.excalidraw').getByRole('button', { name: 'Undo' });

/** Draws a rectangle with the pointer (R is the rectangle tool). */
async function drawRectangle(page: Page): Promise<void> {
  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  // A banner that just appeared took room from the canvas: Excalidraw resizes it a moment later,
  // and until then its bottom is outside the pane.
  await expect
    .poll(async () => {
      const host = (await page.locator('.drawing-canvas').boundingBox())!;
      return Math.abs((await canvas.boundingBox())!.height - host.height);
    })
    .toBeLessThan(2);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height - 4);
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 420, box.y + 320);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 400, { steps: 6 });
  await page.mouse.up();
}

test('opening a drawing writes nothing', async ({ page }) => {
  const text = shape(
    't',
    0,
    0,
    80,
    25,
    {
      text: 'hello',
      originalText: 'hello',
      fontSize: 20,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    },
    'text',
  );
  const seed = scene([shape('a', 0, 100, 100, 60), text]);
  await openDrawing(page, seed);
  // Twice the autosave delay: fonts loaded, texts measured, nothing reported as an edit.
  await page.waitForTimeout(4500);
  await expect(page.locator('.save-state')).toHaveText('Saved');
  expect(await file(page)).toBe(seed);
});

test('a drawing too large to be indexed says so, by the size of the file as saved', async ({
  page,
}) => {
  // 8.6 MB of a picture no element uses: Excalidraw leaves it out at the next save.
  const heavy = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'clarae',
    elements: [shape('a', 0, 0, 100, 60)],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {
      unused: {
        id: 'unused',
        mimeType: 'image/png',
        dataURL: `data:image/png;base64,${'A'.repeat(8_600_000)}`,
        created: 1,
      },
    },
  });
  await openDrawing(page, heavy);
  const warning = page.locator('.drawing-view .banner[role="status"]');
  await expect(warning).toContainText('larger than 8 MB');
  await expect(warning).toContainText('not searchable');

  // An edit, a save: the file is small again, and the warning goes with the megabytes.
  await drawRectangle(page);
  await waitSaved(page);
  expect((await file(page)).length).toBeLessThan(100_000);
  await expect(warning).toHaveCount(0);
});

test('a change from outside shows in the open editor and is not written back', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  await page.keyboard.press('ControlOrMeta+Shift+r');
  await page.getByRole('tab', { name: 'Slides' }).click();
  expect(await cornerColor(page)).toEqual([255, 255, 255]);

  const outside = withBackground(
    [shape('a', 0, 0, 100, 60), frame('f1', 500, 'Intro'), frame('f2', 900, 'Outro')],
    '#ffc9c9',
  );
  await seedVault(page, { files: { 'Board.excalidraw': outside } });

  // The frames of the new version reach the Slideshow tab, the background the canvas.
  await expect(page.getByText('Frame slideshow · 2 of 2 included')).toBeVisible();
  await expect.poll(() => cornerColor(page)).toEqual([255, 201, 201]);
  // Showing somebody else's version is not an edit: nothing is saved over it.
  await page.waitForTimeout(3500);
  await expect(page.locator('.save-state')).toHaveText('Saved');
  expect(await file(page)).toBe(outside);
});

test('a file that stops being a drawing is not overwritten, and shows again once repaired', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  const broken = '{"type":"excalidraw","elements":[';
  await seedVault(page, { files: { 'Board.excalidraw': broken } });
  await expect(conflict(page)).toContainText('no longer a valid drawing');
  await expect(conflict(page).getByRole('button', { name: 'Reload' })).toHaveCount(0);

  // Repaired outside: the editor shows it, the warning goes.
  const repaired = scene([shape('a', 0, 0, 100, 60), frame('f1', 500, 'Intro')]);
  await seedVault(page, { files: { 'Board.excalidraw': repaired } });
  await expect(conflict(page)).toHaveCount(0);
  await expect(page.locator('.save-state')).toHaveText('Saved');

  // Broken again, and this time the user goes on drawing: the autosave leaves the file alone.
  await seedVault(page, { files: { 'Board.excalidraw': broken } });
  await expect(conflict(page)).toContainText('no longer a valid drawing');
  await drawRectangle(page);
  await page.waitForTimeout(3500);
  expect(await file(page)).toBe(broken);

  // Overwriting is the user's choice: the file is the drawing on screen again.
  await conflict(page).getByRole('button', { name: 'Overwrite' }).click();
  await waitSaved(page);
  const saved = await savedDrawing(page);
  expect(
    saved.elements
      .filter((e) => !e['isDeleted'])
      .map((e) => e.type)
      .sort(),
  ).toEqual(['frame', 'rectangle', 'rectangle']);
});

test('an action is one undo step', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 400, 0, 60, 60)]));
  await selectAll(page);
  await runCommand(page, 'fixed horizontal gap');
  await answerPrompt(page, '10');
  await waitSaved(page);
  expect((await savedDrawing(page)).elements.find((e) => e.id === 'b')?.x).toBe(110);

  await undo(page).click();
  await expect
    .poll(async () => (await savedDrawing(page)).elements.find((e) => e.id === 'b')?.x, {
      timeout: 15_000,
    })
    .toBe(400);
});

test('a change from outside is not a step of the undo history', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]));
  // Somebody else adds a shape to the file; then a rectangle is drawn here.
  await seedVault(page, {
    files: {
      'Board.excalidraw': scene([shape('a', 0, 0, 100, 60), shape('theirs', 900, 0, 80, 80)]),
    },
  });
  await page.waitForTimeout(1000);
  await drawRectangle(page);
  await waitSaved(page);
  const before = (await savedDrawing(page)).elements;
  expect(before.map((e) => e.id)).toContain('theirs');
  const mine = before.find((e) => e.id !== 'a' && e.id !== 'theirs')!;

  // Undo takes back the rectangle drawn here, and only that.
  await undo(page).click();
  await expect
    .poll(
      async () => {
        const els = (await savedDrawing(page)).elements;
        return {
          mine: els.find((e) => e.id === mine.id)?.['isDeleted'] ?? 'gone',
          theirs: els.find((e) => e.id === 'theirs')?.['isDeleted'] ?? 'gone',
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ mine: true, theirs: false });
});
