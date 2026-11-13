import { expect, test } from './support';
import {
  openDrawing,
  runCommand,
  savedDrawing,
  scene,
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
