import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support';
import {
  openDrawing,
  runCommand,
  savedDrawing,
  scene,
  shape,
  waitSaved,
  watchNetwork,
} from './drawingHelpers';

const EMPTY = scene([]);

test('a Mermaid diagram becomes editable shapes, saved as plain Excalidraw JSON', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openDrawing(page, EMPTY);
  await runCommand(page, 'insert a diagram from Mermaid');
  const dialog = page.getByRole('dialog', { name: 'Text to diagram (Mermaid)' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Insert diagram' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await waitSaved(page);
  await expect
    .poll(async () => (await savedDrawing(page)).elements.length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(5); // 3 nodes + 3 labels + arrows
  const types = (await savedDrawing(page)).elements.map((e) => e.type);
  expect(types).toContain('rectangle');
  expect(types).toContain('arrow');
  expect(types).toContain('text');
  expect(external).toEqual([]);
});

test('a bad Mermaid text keeps the dialog open and shows the error', async ({ page }) => {
  await openDrawing(page, EMPTY);
  await runCommand(page, 'insert a diagram from Mermaid');
  const dialog = page.getByRole('dialog', { name: 'Text to diagram (Mermaid)' });
  await dialog.getByRole('textbox').fill('flowchart TD\n  A --> --> B ((');
  await dialog.getByRole('button', { name: 'Insert diagram' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toBeVisible();
  expect((await savedDrawing(page)).elements).toHaveLength(0);
});

test('a LaTeX formula is inserted as an image and can be edited from the palette', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openDrawing(page, EMPTY);
  await runCommand(page, 'insert a LaTeX formula');
  const dialog = page.getByRole('dialog', { name: 'Insert a LaTeX formula' });
  await dialog.getByRole('textbox').fill('\\frac{a}{b} + x^2');
  await dialog.getByRole('button', { name: 'Insert' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await waitSaved(page);
  const first = await savedDrawing(page);
  const image = first.elements.find((e) => e.type === 'image');
  expect(image?.customData?.clarae).toMatchObject({
    kind: 'latex',
    latex: '\\frac{a}{b} + x^2',
  });
  const files = Object.values(first.files);
  expect(files).toHaveLength(1);
  expect(files[0]?.mimeType).toBe('image/svg+xml');
  expect(files[0]?.dataURL).toMatch(/^data:image\/svg\+xml;base64,/);

  // The formula is selected after the insert: "Edit" reopens it with its source.
  await runCommand(page, 'edit the selected LaTeX formula');
  const edit = page.getByRole('dialog', { name: 'Edit the LaTeX formula' });
  await expect(edit.getByRole('textbox')).toHaveValue('\\frac{a}{b} + x^2');
  await edit.getByRole('textbox').fill('\\sqrt{y}');
  await edit.getByRole('button', { name: 'Update' }).click();
  await expect(edit).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        (await savedDrawing(page)).elements.find((e) => e.type === 'image')?.customData?.clarae
          ?.latex,
    )
    .toBe('\\sqrt{y}');
  expect(external).toEqual([]);
});

test('double click on a LaTeX formula opens it for editing', async ({ page }) => {
  await openDrawing(page, EMPTY);
  await runCommand(page, 'insert a LaTeX formula');
  const dialog = page.getByRole('dialog', { name: 'Insert a LaTeX formula' });
  await dialog.getByRole('textbox').fill('E = mc^2');
  await dialog.getByRole('button', { name: 'Insert' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await waitSaved(page);

  // New formulas are centred on the viewport.
  const box = (await page.locator('.drawing-canvas .excalidraw canvas.interactive').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const edit = page.getByRole('dialog', { name: 'Edit the LaTeX formula' });
  await expect(edit).toBeVisible();
  await expect(edit.getByRole('textbox')).toHaveValue('E = mc^2');
});

// Editing a text and moving shapes work only if the Excalidraw fork has its host (drawing/excalidrawHost.ts):
// without one its text editor throws as it opens, the text stays hidden and nothing can be dragged after.
const canvasOf = (page: Page): Locator =>
  page.locator('.drawing-canvas .excalidraw canvas.interactive');
const editor = (page: Page): Locator => page.locator('textarea.excalidraw-wysiwyg');
const textOf = (
  id: string,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
): ReturnType<typeof shape> =>
  shape(
    id,
    x,
    y,
    w,
    h,
    {
      text,
      originalText: text,
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
const zoomReadout = async (page: Page): Promise<number> =>
  parseInt(
    (await page.locator('.excalidraw').getByRole('button', { name: 'Reset zoom' }).innerText()) ||
      '100',
    10,
  ) / 100;

test('a double click on the empty canvas opens a text editor that takes what is typed', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openDrawing(page, EMPTY);
  const box = (await canvasOf(page).boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Hello Clarae');
  await expect(editor(page)).toHaveValue('Hello Clarae');
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);

  await waitSaved(page);
  const texts = (await savedDrawing(page)).elements.filter((e) => e.type === 'text');
  expect(texts).toHaveLength(1);
  expect(texts[0]?.['text']).toBe('Hello Clarae');
  expect(external).toEqual([]);
});

test('a double click on a text edits it, and a shape can be dragged afterwards', async ({
  page,
}) => {
  await openDrawing(
    page,
    scene([
      textOf('t', 'Old text', 0, 0, 120, 25),
      shape('r', 0, 200, 200, 120, { backgroundColor: '#ffd8a8' }),
    ]),
  );
  const canvas = canvasOf(page);
  const box = (await canvas.boundingBox())!;
  const z = await zoomReadout(page);
  // The content is centered on open: its middle is the middle of the canvas (scene 100,160).
  const at = (sx: number, sy: number) => ({
    x: box.x + box.width / 2 + (sx - 100) * z,
    y: box.y + box.height / 2 + (sy - 160) * z,
  });
  const onText = at(60, 12);
  await page.mouse.dblclick(onText.x, onText.y);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveValue('Old text');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('New text');
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  await waitSaved(page);
  const after = (await savedDrawing(page)).elements.find((e) => e.id === 't');
  expect(after?.['text']).toBe('New text');

  // A text was being edited: nothing may stay "under edit" and block the dragging.
  const before = (await savedDrawing(page)).elements.find((e) => e.id === 'r')!;
  const from = at(100, 260);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 80 * z, from.y + 50 * z, { steps: 8 });
  await page.mouse.up();
  await waitSaved(page);
  await expect
    .poll(async () => (await savedDrawing(page)).elements.find((e) => e.id === 'r')?.x)
    .not.toBe(before.x);
  const dragged = (await savedDrawing(page)).elements.find((e) => e.id === 'r')!;
  expect(dragged.x - before.x).toBeCloseTo(80, 0);
  expect(dragged.y - before.y).toBeCloseTo(50, 0);
});

test('a shape is resized by its handle and the new size is saved', async ({ page }) => {
  await openDrawing(page, scene([shape('r', 0, 0, 240, 140, { backgroundColor: '#a5d8ff' })]));
  const canvas = canvasOf(page);
  const box = (await canvas.boundingBox())!;
  const z = await zoomReadout(page);
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(centre.x, centre.y); // selects it (inside the fill)
  // The bottom-right corner handle.
  const corner = { x: centre.x + 120 * z, y: centre.y + 70 * z };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60 * z, corner.y + 40 * z, { steps: 8 });
  await page.mouse.up();
  await waitSaved(page);
  await expect
    .poll(async () => (await savedDrawing(page)).elements.find((e) => e.id === 'r')?.width)
    .toBeGreaterThan(280);
  const r = (await savedDrawing(page)).elements.find((e) => e.id === 'r')!;
  expect(r.width).toBeCloseTo(300, -1);
  expect(r.height).toBeCloseTo(180, -1);
});

test('the text editor keeps the focus while a style panel of the fork is open', async ({
  page,
}) => {
  // The panels of the fork are aria-modal: the focus keeper of the application must not pull the
  // focus away from the text being typed.
  await openDrawing(page, scene([textOf('t', 'Old', 0, 0, 120, 25)]));
  const box = (await canvasOf(page).boundingBox())!;
  const z = await zoomReadout(page);
  const onText = { x: box.x + box.width / 2 - 40 * z, y: box.y + box.height / 2 };
  await page.mouse.click(onText.x, onText.y); // selects the text
  await page
    .locator('.excalidraw .App-toolbar-content')
    .getByRole('button', { name: 'Edit' })
    .click();
  await expect(page.locator('.excalidraw .color-picker-container')).toBeVisible();
  await page.mouse.dblclick(onText.x, onText.y);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Typed');
  await expect(editor(page)).toBeFocused();
  await expect(editor(page)).toHaveValue('Typed');
  await page.keyboard.press('Escape');
  await waitSaved(page);
  expect((await savedDrawing(page)).elements.find((e) => e.id === 't')?.['text']).toBe('Typed');
});
