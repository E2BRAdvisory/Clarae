import { expect, test } from '@playwright/test';
import {
  answerPrompt,
  openDrawing,
  runCommand,
  savedDrawing,
  scene,
  selectAll,
  shape,
  waitSaved,
  type MockWindow,
} from './drawingHelpers';

const text = (id: string, t: string, x: number, y: number) =>
  shape(
    id,
    x,
    y,
    120,
    25 * t.split('\n').length,
    {
      text: t,
      originalText: t,
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

const live = async (page: Parameters<typeof savedDrawing>[0]) =>
  (await savedDrawing(page)).elements.filter((e) => !e['isDeleted']);

test('boolean union replaces two overlapping shapes with one closed line', async ({ page }) => {
  await openDrawing(
    page,
    scene([
      shape('a', 0, 0, 100, 100, { backgroundColor: '#ffc9c9' }),
      shape('b', 50, 50, 100, 100, { backgroundColor: '#a5d8ff' }),
    ]),
  );
  await selectAll(page);
  await runCommand(page, 'unite the selected shapes');
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(1);
  await waitSaved(page);
  const [u] = await live(page);
  expect(u).toMatchObject({ type: 'line', backgroundColor: '#ffc9c9' });
  const pts = u!['points'] as [number, number][];
  expect(pts[0]).toEqual(pts[pts.length - 1]);
  // Area of the union = 10000 + 10000 - 2500 (shoelace over the closed ring).
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++)
    a += pts[i]![0] * pts[i + 1]![1] - pts[i + 1]![0] * pts[i]![1];
  expect(Math.abs(a / 2)).toBeCloseTo(17500, 3);
});

test('split text by lines and join them back', async ({ page }) => {
  await openDrawing(page, scene([text('t', 'one\ntwo\nthree', 0, 0)]));
  await selectAll(page);
  await runCommand(page, 'split the selected text into one text per line');
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(3);
  await waitSaved(page);
  expect((await live(page)).map((e) => e['text']).sort()).toEqual(['one', 'three', 'two']);

  await selectAll(page);
  await runCommand(page, 'join the selected texts into one');
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(1);
  expect((await live(page))[0]?.['text']).toBe('one\ntwo\nthree');
});

test('repeat elements makes offset copies', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 50, 50)]));
  await selectAll(page);
  await runCommand(page, 'repeat the selected elements');
  await answerPrompt(page, '2'); // copies
  await answerPrompt(page, '100'); // dx
  await answerPrompt(page, '0'); // dy
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(3);
  await waitSaved(page);
  expect((await live(page)).map((e) => e.x).sort((x, y) => x - y)).toEqual([0, 100, 200]);
});

test('select elements of a type updates the selection (visible in the export dialog)', async ({
  page,
}) => {
  await openDrawing(
    page,
    scene([
      shape('a', 0, 0, 50, 50),
      shape('b', 100, 0, 50, 50),
      shape('e', 200, 0, 50, 50, {}, 'ellipse'),
    ]),
  );
  await runCommand(page, 'select all elements of a type');
  await page
    .getByRole('listbox', { name: 'Element type' })
    .getByRole('button', { name: 'Rectangle' })
    .click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('option', { name: 'The selection (2 elements)' })).toBeEnabled();
});

test('toggle grid and set grid size act on the view without touching the file', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 50, 50)]));
  const before = JSON.stringify(await savedDrawing(page));
  await runCommand(page, 'show or hide the grid');
  await runCommand(page, 'set the grid size');
  await answerPrompt(page, '40');
  await page.waitForTimeout(2500); // longer than the autosave delay
  expect(JSON.stringify(await savedDrawing(page))).toBe(before);
});

test('deconstruct moves the selection into a new drawing and opens it', async ({ page }) => {
  await openDrawing(page, scene([shape('keep', 0, 0, 50, 50), shape('move', 200, 0, 50, 50)]));
  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height - 4);
  // Select just one element by its id through the scene API-free path: click it.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await selectAll(page);
  await runCommand(page, 'move the selection into a new drawing');
  await expect(page.getByRole('tab', { name: /Board - part\.excalidraw/ })).toBeVisible({
    timeout: 15_000,
  });
  const read = () =>
    page.evaluate(() => {
      const w = window as unknown as MockWindow;
      const v = [...w.__mock.vaults.values()][0]!;
      return {
        part: JSON.parse(v.files.get('Board - part.excalidraw') ?? '{}') as {
          elements: { id: string }[];
        },
        board: JSON.parse(v.files.get('Board.excalidraw') ?? '{}') as {
          elements: { id: string; isDeleted?: boolean }[];
        },
      };
    });
  expect((await read()).part.elements.map((e) => e.id).sort()).toEqual(['keep', 'move']);
  // The source drawing saves the removal before the new tab opens (Excalidraw writes only live elements).
  await expect
    .poll(async () => (await read()).board.elements.filter((e) => !e.isDeleted).length, {
      timeout: 20_000,
    })
    .toBe(0);
});

test('create a new note and embed it adds the note file and its card', async ({ page }) => {
  await openDrawing(page, scene([]));
  await runCommand(page, 'create a new note and add its card');
  await answerPrompt(page, 'Meeting: notes');
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(2);
  const note = await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    return [...[...w.__mock.vaults.values()][0]!.files.keys()].filter((k) => k.endsWith('.md'));
  });
  expect(note).toEqual(['Meeting- notes.md']);
  const card = (await live(page)).find((e) => e.type === 'rectangle')!;
  expect(card['link']).toBe('[[Meeting- notes]]');
});

test('refresh note cards re-reads the notes into the cards', async ({ page }) => {
  await openDrawing(page, scene([]), { files: { 'Plan.md': '# Plan\n\nOld text here.\n' } });
  await runCommand(page, 'insert a note as a card');
  await answerPrompt(page, 'Plan');
  await page
    .getByRole('listbox', { name: 'Insert a note as a card' })
    .getByRole('button', { name: 'Plan' })
    .click();
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(2);
  await waitSaved(page);

  await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    [...w.__mock.vaults.values()][0]!.files.set('Plan.md', '# Plan\n\nBrand new content now.\n');
  });
  await selectAll(page);
  await runCommand(page, 'update the selected note cards');
  await expect
    .poll(
      async () =>
        String((await live(page)).find((e) => e.type === 'text')?.['text']).replace(/\s+/g, ' '),
      { timeout: 15_000 },
    )
    .toContain('Brand new content now.');
});

test('the auto-export of one drawing overrides the vault setting and lives in the file', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 50, 50)]));
  // Vault setting: PNG and SVG; this drawing: PNG only.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Drawings' }).click();
  await page.getByLabel('Auto-export on save').selectOption('both');
  await page.keyboard.press('Escape');

  await runCommand(page, 'choose the auto-export of this drawing');
  await page
    .getByRole('listbox', { name: 'Auto-export of this drawing' })
    .getByRole('button', { name: 'PNG', exact: true })
    .click();
  await waitSaved(page);
  await expect
    .poll(
      async () =>
        (
          JSON.parse(
            await page.evaluate(() => {
              const w = window as unknown as MockWindow;
              return [...w.__mock.vaults.values()][0]!.files.get('Board.excalidraw') ?? '{}';
            }),
          ) as { memobrain?: { autoExport?: string } }
        ).memobrain?.autoExport,
      { timeout: 15_000 },
    )
    .toBe('png');
  await expect
    .poll(
      () =>
        page.evaluate(() => [...(window as unknown as MockWindow).__mock.drawingExports.keys()]),
      { timeout: 20_000 },
    )
    .toEqual(['Board.excalidraw.png']);
  // Everything else in the file is intact.
  expect((await savedDrawing(page)).elements.map((e) => e.id)).toEqual(['a']);
});

test('Print / PDF puts the drawing on the print layer and asks the system to print', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60, { backgroundColor: '#ffc9c9' })]));
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Print / PDF…' }).click();
  await expect(page.locator('#memobrain-print img')).toHaveCount(1);
  const src = await page.locator('#memobrain-print img').getAttribute('src');
  expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(Buffer.from(src!.split(',')[1]!, 'base64').toString('utf8')).toContain('<svg');
  expect(
    await page.evaluate(() => (window as unknown as { __mock: { prints: number } }).__mock.prints),
  ).toBe(1);
});

test('auto layout arranges connected shapes in layers and keeps the arrows attached', async ({
  page,
}) => {
  await openDrawing(
    page,
    scene([
      shape('a', 600, 100, 100, 50),
      shape('b', 0, 300, 100, 50),
      shape('c', 300, 0, 100, 50),
    ]),
  );
  await selectAll(page);
  await runCommand(page, 'connect the selected elements'); // b → c → a, in reading order
  await expect
    .poll(async () => (await live(page)).filter((e) => e.type === 'arrow').length, {
      timeout: 15_000,
    })
    .toBe(2);
  await waitSaved(page);

  await selectAll(page);
  await runCommand(page, 'arrange the selection in layers');
  await answerPrompt(page, '60'); // horizontal gap
  await answerPrompt(page, '30'); // vertical gap
  await expect
    .poll(async () => (await live(page)).find((e) => e.id === 'a')?.x, { timeout: 15_000 })
    .toBe(0 + 2 * (100 + 60)); // b at the left edge, then c, then a
  await waitSaved(page);
  const els = await live(page);
  const x = (id: string) => els.find((e) => e.id === id)!.x;
  expect([x('b'), x('c'), x('a')]).toEqual([0, 160, 320]);
  // Every arrow still ends on the left side of its target shape.
  for (const arrow of els.filter((e) => e.type === 'arrow')) {
    const pts = arrow['points'] as [number, number][];
    const endX = arrow.x + pts[pts.length - 1]![0];
    const endY = arrow.y + pts[pts.length - 1]![1];
    const t = els.find((e) => e.id === (arrow['endBinding'] as { elementId: string }).elementId)!;
    // The end stays on the outline of its target shape, wherever the layout put it.
    expect(endX).toBeGreaterThanOrEqual(t.x - 1);
    expect(endX).toBeLessThanOrEqual(t.x + t.width + 1);
    expect(endY).toBeGreaterThanOrEqual(t.y - 1);
    expect(endY).toBeLessThanOrEqual(t.y + t.height + 1);
  }
});

test('another drawing is inserted as a picture, from the command and from a drop', async ({
  page,
}) => {
  await openDrawing(page, scene([]), {
    files: {
      'Other.excalidraw': scene([shape('o', 0, 0, 160, 90, { backgroundColor: '#b2f2bb' })]),
    },
  });
  await runCommand(page, 'insert another drawing as a picture');
  const list = page.getByRole('listbox', { name: 'Insert a drawing' });
  await expect(list.getByRole('button', { name: 'Board' })).toHaveCount(0); // never itself
  await list.getByRole('button', { name: 'Other' }).click();
  await expect
    .poll(async () => (await live(page)).some((e) => e.type === 'image'), { timeout: 20_000 })
    .toBe(true);
  await waitSaved(page);
  const saved = await savedDrawing(page);
  const img = saved.elements.find((e) => e.type === 'image')!;
  expect(img.customData?.memobrain).toMatchObject({ kind: 'drawing', path: 'Other.excalidraw' });
  const file = Object.values(saved.files)[0]!;
  expect(file.mimeType).toBe('image/svg+xml');
  expect(Buffer.from(file.dataURL.split(',')[1]!, 'base64').toString('utf8')).toContain('<svg');
  expect(img.width).toBeGreaterThan(50);

  // And by dropping it from the file explorer.
  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  // (With an element selected Excalidraw shows its properties panel on the left: drop on the right.)
  const box = (await canvas.boundingBox())!;
  await page.locator('.tree .node', { hasText: 'Other' }).dragTo(canvas, {
    targetPosition: { x: Math.round(box.width - 140), y: Math.round(box.height - 120) },
  });
  await expect
    .poll(async () => (await live(page)).filter((e) => e.type === 'image').length, {
      timeout: 20_000,
    })
    .toBe(2);
});
