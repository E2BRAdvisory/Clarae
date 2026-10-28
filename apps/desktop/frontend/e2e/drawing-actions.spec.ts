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
} from './drawingHelpers';

const text = (id: string, x: number, y: number) =>
  shape(
    id,
    x,
    y,
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

const byId = async (page: Parameters<typeof savedDrawing>[0]) =>
  Object.fromEntries((await savedDrawing(page)).elements.map((e) => [e.id, e]));

test('fixed horizontal gap chains the selection after the first element', async ({ page }) => {
  await openDrawing(
    page,
    scene([shape('a', 0, 0, 100, 60), shape('b', 400, 20, 60, 60), shape('c', 130, 40, 80, 60)]),
  );
  await selectAll(page);
  await runCommand(page, 'fixed horizontal gap');
  await answerPrompt(page, '30');
  await waitSaved(page);

  const els = await byId(page);
  expect(els['a']?.x).toBe(0);
  expect(els['c']?.x).toBe(130); // 0 + 100 + 30
  expect(els['b']?.x).toBe(240); // 130 + 80 + 30
  // Only x changes.
  expect([els['a']?.y, els['b']?.y, els['c']?.y]).toEqual([0, 20, 40]);
});

test('a cancelled prompt changes nothing', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 400, 0, 60, 60)]));
  await selectAll(page);
  await runCommand(page, 'fixed horizontal gap');
  await expect(page.locator('#dialog-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog-input')).toHaveCount(0);
  expect((await byId(page))['b']?.x).toBe(400);
});

test('expand rectangles makes them as wide as the largest', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 40), shape('b', 0, 100, 60, 40)]));
  await selectAll(page);
  await runCommand(page, 'expand rectangles horizontally');
  await waitSaved(page);
  const els = await byId(page);
  expect([els['a']?.width, els['b']?.width]).toEqual([100, 100]);
});

test('darken the background asks a percentage and keeps transparent shapes', async ({ page }) => {
  await openDrawing(
    page,
    scene([
      shape('red', 0, 0, 100, 60, { backgroundColor: '#ff0000' }),
      shape('none', 200, 0, 100, 60),
    ]),
  );
  await selectAll(page);
  await runCommand(page, 'darken the background');
  await answerPrompt(page, '20');
  await waitSaved(page);
  const els = await byId(page);
  expect(els['red']?.backgroundColor).toBe('#990000');
  expect(els['none']?.backgroundColor).toBe('transparent');
});

test('text alignment uses a picker', async ({ page }) => {
  await openDrawing(page, scene([text('t1', 0, 0), shape('r', 200, 0, 50, 50)]));
  await selectAll(page);
  await runCommand(page, 'set the alignment of selected text');
  await page
    .getByRole('listbox', { name: 'Text alignment' })
    .getByRole('button', { name: 'Right' })
    .click();
  await waitSaved(page);
  const els = await byId(page);
  expect(els['t1']?.textAlign).toBe('right');
  expect(els['r']?.textAlign).toBeUndefined();
});

test('layout commands are disabled without a big enough selection', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 400, 0, 60, 60)]));
  // Nothing selected: the palette finds the command but it does not run.
  await runCommand(page, 'fixed horizontal gap');
  await expect(page.locator('#dialog-input')).toHaveCount(0);
});

test('the result of an action survives a reload of the file (versions bumped, ids kept)', async ({
  page,
}) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 400, 0, 60, 60)]));
  await selectAll(page);
  await runCommand(page, 'fixed horizontal gap');
  await answerPrompt(page, '10');
  await waitSaved(page);
  const saved = await savedDrawing(page);
  expect(saved.elements.map((e) => e.id).sort()).toEqual(['a', 'b']);
  const b = saved.elements.find((e) => e.id === 'b')!;
  expect(b.x).toBe(110);
  expect(Number(b['version'])).toBeGreaterThan(1);
  expect(Number(b['versionNonce'])).not.toBe(1);
});

test('connect elements adds an arrow bound to both shapes', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 400, 0, 100, 60)]));
  await selectAll(page);
  await runCommand(page, 'connect the selected elements');
  await waitSaved(page);
  const els = (await savedDrawing(page)).elements;
  const arrow = els.find((e) => e.type === 'arrow')!;
  expect(arrow).toBeTruthy();
  expect(arrow['startBinding']).toMatchObject({ elementId: 'a' });
  expect(arrow['endBinding']).toMatchObject({ elementId: 'b' });
  const ids = els.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  // Both shapes reference the arrow, as Excalidraw needs to treat it as bound.
  for (const id of ['a', 'b'])
    expect(els.find((e) => e.id === id)?.['boundElements']).toEqual([
      { id: arrow.id, type: 'arrow' },
    ]);
});

test('a bound arrow follows the shapes when a layout action moves them', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 400, 0, 100, 60)]));
  await selectAll(page);
  await runCommand(page, 'connect the selected elements');
  await waitSaved(page);

  await selectAll(page);
  await runCommand(page, 'fixed horizontal gap');
  await answerPrompt(page, '50');
  await expect.poll(async () => (await byId(page))['b']?.x, { timeout: 15_000 }).toBe(150); // 0 + 100 + 50
  await waitSaved(page);

  const els = await byId(page);
  const arrow = Object.values(els).find((e) => e.type === 'arrow')!;
  const pts = arrow['points'] as [number, number][];
  const end = pts[pts.length - 1]!;
  // The arrow still starts at a's side and ends where b's left side now is (x = 150).
  expect(arrow.x + end[0]).toBeCloseTo(150, 5);
  expect(arrow.x).toBeLessThan(150);
});

test('box selected elements draws a rectangle around everything selected', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 100, 60), shape('b', 300, 100, 100, 60)]));
  await selectAll(page);
  await runCommand(page, 'draw a box around the selection');
  await answerPrompt(page, '10');
  await waitSaved(page);
  const els = (await savedDrawing(page)).elements;
  expect(els).toHaveLength(3);
  const box = els.find((e) => e.id !== 'a' && e.id !== 'b')!;
  expect(box).toMatchObject({ type: 'rectangle', x: -10, y: -10, width: 420, height: 180 });
});

test('add next step copies the shape and links it', async ({ page }) => {
  await openDrawing(page, scene([shape('s', 0, 0, 100, 60, { backgroundColor: '#a5d8ff' })]));
  await selectAll(page);
  await runCommand(page, 'add the next step of a process');
  await answerPrompt(page, '60');
  await waitSaved(page);
  const els = (await savedDrawing(page)).elements;
  expect(els.map((e) => e.type).sort()).toEqual(['arrow', 'rectangle', 'rectangle']);
  const copy = els.find((e) => e.type === 'rectangle' && e.id !== 's')!;
  expect(copy).toMatchObject({ x: 160, y: 0, backgroundColor: '#a5d8ff' });
});

test('change shape uses a picker', async ({ page }) => {
  await openDrawing(page, scene([shape('r', 0, 0, 100, 60)]));
  await selectAll(page);
  await runCommand(page, 'change the shape of selected elements');
  await page
    .getByRole('listbox', { name: 'Shape' })
    .getByRole('button', { name: 'Ellipse' })
    .click();
  await waitSaved(page);
  expect((await byId(page))['r']?.type).toBe('ellipse');
});
