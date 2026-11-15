import type { Page } from '@playwright/test';
import { expect, skipOnWeb, test } from './support';
import {
  binaries,
  openDrawing,
  scene,
  selectAll,
  shape,
  waitSaved,
  watchNetwork,
  type MockWindow,
} from './drawingHelpers';

// A frame "Intro" with one shape inside, and a distant shape outside of it.
const WITH_FRAME = scene([
  shape('f1', 0, 0, 300, 200, { name: 'Intro' }, 'frame'),
  shape('in', 40, 40, 100, 60, { frameId: 'f1', backgroundColor: '#ffc9c9' }),
  shape('out', 900, 700, 120, 80),
]);

/** Width and height of a PNG from its base64 IHDR chunk. */
function pngSize(base64: string): { w: number; h: number } {
  const b = Buffer.from(base64.slice(0, 64), 'base64');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const svgWidth = (base64: string): number =>
  Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(Buffer.from(base64, 'base64').toString('utf8'))?.[1]);

async function openExport(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const lastFileExport = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as MockWindow;
    return w.__mock.fileExports.at(-1) ?? null;
  });

test('Save as… writes a valid PNG through the native dialog, with the chosen scale', async ({
  page,
}) => {
  skipOnWeb(
    'drawing.export',
    'the spec reads the files the Wails mock captures from the save dialog (window.__mock.fileExports); in the browser an export is a download',
  );
  const external = watchNetwork(page);
  await openDrawing(page, WITH_FRAME);

  for (const scale of [1, 3]) {
    const dialog = await openExport(page);
    await dialog.getByLabel('Scale').selectOption(String(scale));
    await dialog.getByLabel('Padding (px)').fill('0');
    await dialog.getByRole('button', { name: 'Save as…' }).click();
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible(); // the "saved" notice
    await page.getByRole('button', { name: 'OK' }).click();
  }

  const exports = await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    return w.__mock.fileExports;
  });
  expect(exports.map((e) => e.mime)).toEqual(['image/png', 'image/png']);
  expect(exports[0]?.name).toMatch(/^Board\.png$/);
  expect(exports[1]?.name).toMatch(/^Board@3x\.png$/);
  for (const e of exports)
    expect(Buffer.from(e.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  const [a, b] = exports.map((e) => pngSize(e.base64));
  // Same drawing at 3x is three times as large as at 1x.
  expect(b!.w / a!.w).toBeCloseTo(3, 1);
  expect(b!.h / a!.h).toBeCloseTo(3, 1);
  expect(external).toEqual([]);
});

test('exporting a frame covers only the frame and embeds the scene when asked', async ({
  page,
}) => {
  skipOnWeb(
    'drawing.export',
    'the spec reads the files the Wails mock captures from the save dialog (window.__mock.fileExports); in the browser an export is a download',
  );
  await openDrawing(page, WITH_FRAME);

  // Whole drawing, SVG.
  let dialog = await openExport(page);
  await dialog.getByLabel('SVG').check();
  await dialog.getByLabel('Padding (px)').fill('0');
  await dialog.getByRole('button', { name: 'Save as…' }).click();
  await page.getByRole('button', { name: 'OK' }).click();
  const whole = (await lastFileExport(page))!;
  expect(whole.mime).toBe('image/svg+xml');

  // Just the frame, with the scene embedded.
  dialog = await openExport(page);
  await dialog.getByLabel('SVG').check();
  await dialog.getByLabel('Padding (px)').fill('0');
  await dialog.getByLabel('Export', { exact: true }).selectOption({ label: 'Frame: Intro' });
  await dialog.getByLabel('Embed the scene').check();
  await dialog.getByRole('button', { name: 'Save as…' }).click();
  await page.getByRole('button', { name: 'OK' }).click();
  const part = (await lastFileExport(page))!;
  expect(part.name).toBe('Board.Intro.svg');
  expect(svgWidth(part.base64)).toBeLessThan(svgWidth(whole.base64));
  const text = Buffer.from(part.base64, 'base64').toString('utf8');
  expect(text).toContain('payload-type:application/vnd.excalidraw+json');
  expect(Buffer.from(whole.base64, 'base64').toString('utf8')).not.toContain('payload-type');
});

test('the selection is exportable only when something is selected', async ({ page }) => {
  await openDrawing(page, WITH_FRAME);
  let dialog = await openExport(page);
  await expect(dialog.getByRole('option', { name: /The selection/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await selectAll(page);
  dialog = await openExport(page);
  await expect(dialog.getByRole('option', { name: /The selection/ })).toBeEnabled();
});

test('Save to vault names the file after the options and cancelling the dialog writes nothing', async ({
  page,
}) => {
  skipOnWeb(
    'drawing.export',
    'the spec cancels the save dialog of the Wails mock (window.__mock.exportCancelled); the browser has no save dialog to cancel',
  );
  await openDrawing(page, WITH_FRAME);
  const dialog = await openExport(page);
  await dialog.getByLabel('Dark theme').check();
  await dialog.getByRole('button', { name: 'Save in the vault' }).click();
  await page.getByRole('button', { name: 'OK' }).click();
  expect(Object.keys(await binaries(page))).toEqual(['Board.dark@2x.png']);

  await page.evaluate(() => {
    (window as unknown as MockWindow).__mock.exportCancelled = true;
  });
  const again = await openExport(page);
  await again.getByRole('button', { name: 'Save as…' }).click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeHidden();
  expect(
    await page.evaluate(() => (window as unknown as MockWindow).__mock.fileExports.length),
  ).toBe(0);
});

const exported = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...(window as unknown as MockWindow).__mock.drawingExports.keys()].sort());

/** Turns the auto-export on in Settings > Drawings, in both formats. */
async function autoExportBoth(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Drawings' }).click();
  await page.getByLabel('Auto-export on save').selectOption('both');
  await page.keyboard.press('Escape');
}

/** Draws a rectangle with the pointer and waits for the save that follows. */
async function drawAndSave(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
  await page.keyboard.press('r');
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 120, box.y + y + 80, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.save-state')).not.toHaveText('Saved');
  await waitSaved(page);
}

test('auto-export writes the PNG and SVG variants next to the drawing when it is closed', async ({
  page,
}) => {
  skipOnWeb(
    'drawing.export',
    'the spec reads the exports the Wails mock captures (window.__mock.drawingExports)',
  );
  await openDrawing(page, WITH_FRAME);

  // Turn it on in Settings > Drawings.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Drawings' }).click();
  await page.getByLabel('Auto-export on save').selectOption('both');
  await page.getByLabel('Auto-export theme').selectOption('both');
  await page.keyboard.press('Escape');

  // A save alone exports nothing: the drawing is still being worked on.
  await drawAndSave(page, 400, 300);
  await page.waitForTimeout(2500);
  expect(await exported(page)).toEqual([]);

  // Closing it does, at once.
  await page.keyboard.press('ControlOrMeta+w');
  await expect
    .poll(() => exported(page), { timeout: 10_000 })
    .toEqual([
      'Board.excalidraw.dark.png',
      'Board.excalidraw.dark.svg',
      'Board.excalidraw.light.png',
      'Board.excalidraw.light.svg',
    ]);
  const png = await page.evaluate(
    () =>
      (window as unknown as MockWindow).__mock.drawingExports.get('Board.excalidraw.dark.png') ??
      '',
  );
  expect(Buffer.from(png, 'base64').subarray(1, 4).toString()).toBe('PNG');
  // The settings were persisted in the vault.
  const cfg = await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    return [...w.__mock.vaults.values()][0]?.files.get('.clarae/drawing.json') ?? '';
  });
  expect(JSON.parse(cfg)).toMatchObject({ autoExport: 'both', autoExportTheme: 'both' });
});

test('auto-export waits for a pause in the work, and exports once', async ({ page }) => {
  skipOnWeb(
    'drawing.export',
    'the spec reads the exports the Wails mock captures (window.__mock.drawingExports)',
  );
  test.setTimeout(60_000);
  await openDrawing(page, WITH_FRAME);
  await autoExportBoth(page);
  // Count the files written, not only which ones: each save must not rewrite them.
  await page.evaluate(() => {
    const exports = (window as unknown as MockWindow).__mock.drawingExports;
    const set = exports.set.bind(exports);
    let writes = 0;
    exports.set = (k: string, v: string) => {
      (window as unknown as { __exportWrites: number }).__exportWrites = ++writes;
      return set(k, v);
    };
  });
  const writes = () =>
    page.evaluate(() => (window as unknown as { __exportWrites?: number }).__exportWrites ?? 0);

  // Three edits, each saved, a few seconds apart: no export in between.
  for (const y of [200, 300, 400]) {
    await drawAndSave(page, 400, y);
    await page.waitForTimeout(1500);
  }
  expect(await writes()).toBe(0);

  // Fifteen seconds after the last save: both files, written once.
  await expect
    .poll(() => exported(page), { timeout: 25_000 })
    .toEqual(['Board.excalidraw.png', 'Board.excalidraw.svg']);
  expect(await writes()).toBe(2);
  // Closing the drawing afterwards has nothing more to export.
  await page.keyboard.press('ControlOrMeta+w');
  await page.waitForTimeout(1500);
  expect(await writes()).toBe(2);
});

test('the ribbon exports a drawing: PNG and SVG open the dialog with the format chosen', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openDrawing(page, WITH_FRAME);
  const ribbon = page.getByRole('navigation', { name: 'Quick actions' });
  await expect(ribbon.getByRole('button', { name: 'Export the presentation to PDF' })).toHaveCount(
    0,
  );

  await ribbon.getByRole('button', { name: 'Drawing: export as SVG image…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'SVG' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'PNG' })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The format of the ribbon button was for that one opening: the toolbar's Export is back to the default.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog.getByRole('radio', { name: 'PNG' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await ribbon.getByRole('button', { name: 'Drawing: export as PNG image…' }).click();
  dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog.getByRole('radio', { name: 'PNG' })).toBeChecked();
  await expect(
    ribbon.getByRole('button', { name: 'Drawing: export the whole drawing to PDF' }),
  ).toBeEnabled();
  expect(external).toEqual([]);
});
