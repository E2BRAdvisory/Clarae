import { expect, test } from '@playwright/test';
import {
  answerPrompt,
  openDrawing,
  type MockWindow,
  runCommand,
  savedDrawing,
  scene,
  shape,
  waitSaved,
  watchNetwork,
} from './drawingHelpers';

// A real 1×1 PNG.
const DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const NOTE =
  '---\ntags: [x]\n---\n# Heading\n\nThe first paragraph has **bold** words and a [[Other]] link.\n';

test('an image of the vault is inserted into the drawing and stored in its files', async ({
  page,
}) => {
  const external = watchNetwork(page);
  await openDrawing(page, scene([]), { binaries: { 'pics/dot.png': DOT_PNG } });
  await runCommand(page, 'insert an image from the vault');
  await page
    .getByRole('listbox', { name: 'Insert an image' })
    .getByRole('button', { name: 'pics/dot.png' })
    .click();
  await expect
    .poll(async () => (await savedDrawing(page)).elements.some((e) => e.type === 'image'), {
      timeout: 15_000,
    })
    .toBe(true);
  await waitSaved(page);

  const saved = await savedDrawing(page);
  const img = saved.elements.find((e) => e.type === 'image')!;
  expect(img).toBeTruthy();
  expect(img.customData?.memobrain).toMatchObject({ kind: 'image', path: 'pics/dot.png' });
  const files = Object.values(saved.files);
  expect(files).toHaveLength(1);
  expect(files[0]?.mimeType).toBe('image/png');
  expect(files[0]?.dataURL).toBe(`data:image/png;base64,${DOT_PNG}`);
  expect(external).toEqual([]);
});

test('with no images in the vault the command says so and changes nothing', async ({ page }) => {
  await openDrawing(page, scene([]));
  await runCommand(page, 'insert an image from the vault');
  await expect(page.getByText('There are no images in this vault.')).toBeVisible();
  expect((await savedDrawing(page)).elements).toHaveLength(0);
});

test('a note becomes a linked card: container, bound text, link to the note', async ({ page }) => {
  await openDrawing(page, scene([]), { files: { 'Notes/My note.md': NOTE, 'Other.md': 'x' } });
  await runCommand(page, 'insert a note as a card');
  await answerPrompt(page, 'My note');
  await page
    .getByRole('listbox', { name: 'Insert a note as a card' })
    .getByRole('button', { name: 'Notes/My note' })
    .click();
  await expect
    .poll(async () => (await savedDrawing(page)).elements.length, { timeout: 15_000 })
    .toBe(2);
  await waitSaved(page);

  const els = (await savedDrawing(page)).elements;
  const card = els.find((e) => e.type === 'rectangle')!;
  const label = els.find((e) => e.type === 'text')!;
  expect(card['link']).toBe('[[Notes/My note]]');
  expect(card['boundElements']).toEqual([{ id: label.id, type: 'text' }]);
  expect(label['containerId']).toBe(card.id);
  // Excalidraw re-wraps the label to the card's width: compare without line breaks.
  const text = String(label['text']).replace(/\s+/g, ' ');
  expect(text).toContain('My note');
  expect(text).toContain('The first paragraph has bold words and a Other link.');
  expect(text).not.toMatch(/tags|\*\*|\[\[|Heading/);
  // The card fits its text (Excalidraw measured it with the real font).
  expect(Number(card.width)).toBeGreaterThanOrEqual(Number(label.width));
  expect(Number(card.height)).toBeGreaterThanOrEqual(Number(label.height));
});

test('hovering a note card with the modifier previews the note', async ({ page }) => {
  await openDrawing(page, scene([]), { files: { 'Notes/My note.md': NOTE } });
  await runCommand(page, 'insert a note as a card');
  await answerPrompt(page, 'My note');
  await page
    .getByRole('listbox', { name: 'Insert a note as a card' })
    .getByRole('button', { name: 'Notes/My note' })
    .click();
  await waitSaved(page);

  // The card is centred on the viewport.
  const box = (await page.locator('.drawing-canvas .excalidraw canvas.interactive').boundingBox())!;
  await page.keyboard.down('ControlOrMeta');
  await page.mouse.move(box.x + box.width / 2 - 3, box.y + box.height / 2 - 3);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  const preview = page.locator('.page-preview');
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(preview.locator('.page-preview-body')).toContainText('The first paragraph');
  await page.keyboard.up('ControlOrMeta');
});

test('a note card keeps its link as a plain wikilink in the drawing JSON', async ({ page }) => {
  // A plain wikilink in the JSON is what the Go rename logic rewrites when the note is renamed
  // (covered by internal/links tests); here we check the shape of the stored link.
  await openDrawing(page, scene([shape('x', 0, 0, 10, 10)]), {
    files: { 'Notes/My note.md': NOTE },
  });
  await runCommand(page, 'insert a note as a card');
  await answerPrompt(page, 'note');
  await page
    .getByRole('listbox', { name: 'Insert a note as a card' })
    .getByRole('button', { name: 'Notes/My note' })
    .click();
  await expect
    .poll(async () => (await savedDrawing(page)).elements.length, { timeout: 15_000 })
    .toBe(3);
  await waitSaved(page);
  const raw = JSON.stringify(await savedDrawing(page));
  expect(raw).toContain('"link":"[[Notes/My note]]"');
});

test('dragging a note and an image from the explorer onto the canvas adds them where dropped', async ({
  page,
}) => {
  await openDrawing(page, scene([]), {
    files: { 'Plan.md': '# Plan\n\nDrop me.\n' },
    binaries: { 'dot.png': DOT_PNG },
  });
  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  const box = (await canvas.boundingBox())!;

  await page
    .locator('.tree .node', { hasText: 'Plan' })
    .dragTo(canvas, { targetPosition: { x: 300, y: 200 } });
  await expect
    .poll(async () => (await savedDrawing(page)).elements.length, { timeout: 15_000 })
    .toBe(2);
  const card = (await savedDrawing(page)).elements.find((e) => e.type === 'rectangle')!;
  // Centered on the drop point (canvas-relative 300,200), within a few px.
  expect(card.x + card.width / 2).toBeGreaterThan(260);
  expect(card.x + card.width / 2).toBeLessThan(340);
  expect(card.y + card.height / 2).toBeGreaterThan(160);
  expect(card.y + card.height / 2).toBeLessThan(240);
  expect(card['link']).toBe('[[Plan]]');

  await page.locator('.tree .node', { hasText: 'dot.png' }).dragTo(canvas, {
    targetPosition: { x: Math.round(box.width - 100), y: 100 },
  });
  await expect
    .poll(async () => (await savedDrawing(page)).elements.some((e) => e.type === 'image'), {
      timeout: 15_000,
    })
    .toBe(true);
  expect(Object.values((await savedDrawing(page)).files)).toHaveLength(1);
});

test('an embed accepts the alignment keywords of the Obsidian plugin', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60)]), {
    files: {
      'Note.md': '# Note\n\n![[Board.excalidraw|200|right-wrap]]\n\nText that flows around.\n',
    },
  });
  await page.locator('.tree .node', { hasText: 'Note' }).click();
  await page.getByRole('button', { name: 'Reading' }).click();
  const wrap = page.locator('.embed-drawing-wrap.align-right-wrap');
  await expect(wrap).toBeVisible({ timeout: 60_000 });
  await expect(wrap.locator('img.embed-drawing')).toHaveAttribute('width', '200');
  expect(await wrap.evaluate((el) => getComputedStyle(el).float)).toBe('right');
});

test('the default style of the vault applies to new drawings', async ({ page }) => {
  await openDrawing(page, scene([]));
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Drawings' }).click();
  await page.getByLabel('Default stroke color').fill('#e03131');
  await page.keyboard.press('Escape');

  // A new drawing starts with that stroke color.
  await runCommand(page, 'New drawing');
  await expect(page.getByRole('tab', { name: /Drawing \d{4}.*excalidraw/ })).toBeVisible();
  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 380, { steps: 6 });
  await page.mouse.up();
  await waitSaved(page);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as MockWindow;
          const v = [...w.__mock.vaults.values()][0]!;
          const name = [...v.files.keys()].find((k) => /^Drawing .*\.excalidraw$/.test(k));
          const doc = JSON.parse(v.files.get(name ?? '') ?? '{"elements":[]}') as {
            elements: { strokeColor: string }[];
          };
          return doc.elements[0]?.strokeColor;
        }),
      { timeout: 15_000 },
    )
    .toBe('#e03131');
});
