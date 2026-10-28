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

const frame = (id: string, name: string, x: number) => shape(id, x, 0, 400, 300, { name }, 'frame');

const live = async (page: Parameters<typeof savedDrawing>[0]) =>
  (await savedDrawing(page)).elements.filter((e) => !e['isDeleted']);

test('the slideshow plays the frames in order and Escape ends it', async ({ page }) => {
  await openDrawing(
    page,
    scene([
      frame('f1', 'Slide 2', 600),
      { ...frame('f2', 'Slide 1', 0), customData: { memobrain: { notes: 'Say hello' } } },
    ]),
  );
  await runCommand(page, 'start the slideshow');
  const bar = page.getByRole('toolbar', { name: 'Slideshow' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 / 2');
  await expect(bar.getByRole('combobox', { name: 'Slide' })).toHaveValue('0');
  await expect(bar).toContainText('Say hello'); // presenter notes of the first slide
  // Going full screen can swallow a key press in headless Chromium: retry (stopping at the last
  // slide makes the press idempotent).
  await expect(async () => {
    await page.keyboard.press('ArrowRight');
    await expect(bar).toContainText('2 / 2', { timeout: 1000 });
  }).toPass();
  await page.keyboard.press('ArrowRight'); // stops at the last slide
  await expect(bar).toContainText('2 / 2');
  await bar.getByRole('button', { name: 'Previous slide' }).click();
  await expect(bar).toContainText('1 / 2');
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
});

test('a drawing without frames presents without slide controls', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 50, 50)]));
  await runCommand(page, 'start the slideshow');
  await expect(page.locator('.drawing-canvas.presenting')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Slideshow' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawing-canvas.presenting')).toHaveCount(0);
});

test('the tools panel searches, runs a generator and remembers favorites', async ({ page }) => {
  await openDrawing(page, scene([shape('a', 0, 0, 50, 50)]));
  await runCommand(page, 'open the tools panel');
  const panel = page.getByRole('dialog', { name: 'Drawing tools' });
  await expect(panel).toBeVisible();
  await panel.getByRole('searchbox', { name: 'Search tools…' }).fill('comic');
  await expect(
    panel.getByRole('button', { name: 'insert comic panels', exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: /calendar/ })).toHaveCount(0);

  await panel.getByRole('button', { name: /Add insert comic panels to favorites/ }).click();
  const favorites = () =>
    page.evaluate(() => {
      const w = window as unknown as MockWindow;
      const raw = [...w.__mock.vaults.values()][0]?.files.get('.memobrain/drawing.json') ?? '{}';
      return (JSON.parse(raw) as { toolFavorites?: string[] }).toolFavorites ?? [];
    });
  await expect.poll(favorites).toEqual(['comic-panels']);

  await panel.getByRole('button', { name: 'insert comic panels', exact: true }).click();
  await answerPrompt(page, '1'); // rows
  await answerPrompt(page, '2'); // columns
  await answerPrompt(page, '100'); // width
  await answerPrompt(page, '80'); // height
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(3);
  await waitSaved(page);
});

test('mind map from an outline text', async ({ page }) => {
  const outline = 'Plan\n  Research\n  Build\n    Test';
  await openDrawing(
    page,
    scene([
      shape(
        't',
        0,
        0,
        120,
        100,
        {
          text: outline,
          originalText: outline,
          fontSize: 20,
          fontFamily: 5,
          textAlign: 'left',
          verticalAlign: 'top',
          containerId: null,
          autoResize: true,
          lineHeight: 1.25,
        },
        'text',
      ),
    ]),
  );
  await selectAll(page);
  await runCommand(page, 'build a mind map');
  await answerPrompt(page, '80');
  await answerPrompt(page, '16');
  await expect.poll(async () => (await live(page)).length, { timeout: 15_000 }).toBe(11);
  await waitSaved(page);
  const els = await live(page);
  expect(els.filter((e) => e.type === 'rectangle')).toHaveLength(4);
  expect(els.filter((e) => e.type === 'arrow')).toHaveLength(3);
  expect(
    els
      .filter((e) => e.type === 'text')
      .map((e) => e['text'])
      .sort(),
  ).toEqual(['Build', 'Plan', 'Research', 'Test']);
});

test('an Obsidian .excalidraw.md is converted into a drawing and opened', async ({ page }) => {
  const md =
    '# Excalidraw Data\n## Drawing\n```json\n' + scene([shape('a', 0, 0, 80, 80)]) + '\n```\n';
  await openDrawing(page, scene([]), { files: { 'Old.excalidraw.md': md } });
  await runCommand(page, 'convert an Obsidian');
  await page
    .getByRole('listbox', { name: 'Convert an Obsidian drawing' })
    .getByRole('button', { name: 'Old.excalidraw.md' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as MockWindow;
        return [...w.__mock.vaults.values()][0]?.files.has('Old.excalidraw') ?? false;
      }),
    )
    .toBe(true);
  await expect(page.getByRole('tab', { name: /Old/ }).first()).toBeVisible();
});

test('importing a .excalidrawlib merges its shapes into the library', async ({ page }) => {
  const lib = JSON.stringify({
    type: 'excalidrawlib',
    version: 2,
    source: 'test',
    libraryItems: [
      { id: 'item1', status: 'unpublished', created: 1, elements: [shape('s', 0, 0, 40, 40)] },
    ],
  });
  await openDrawing(page, scene([]), {
    binaries: { 'Shapes.excalidrawlib': Buffer.from(lib).toString('base64') },
  });
  await runCommand(page, 'import a shape library');
  await page
    .getByRole('listbox', { name: 'Import a shape library' })
    .getByRole('button', { name: 'Shapes.excalidrawlib' })
    .click();
  await expect(page.getByText('1 shapes imported into the library.')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as MockWindow;
        const raw =
          [...w.__mock.vaults.values()][0]?.files.get('.memobrain/excalidraw-library.json') ?? '{}';
        return (JSON.parse(raw) as { libraryItems?: unknown[] }).libraryItems?.length ?? 0;
      }),
    )
    .toBe(1);
});

test('a pen command switches to the freehand tool', async ({ page }) => {
  await openDrawing(page, scene([]));
  await runCommand(page, 'highlighter (yellow)');
  await expect(page.locator('[data-testid="toolbar-freedraw"]')).toBeChecked();
});

test('the drawing can be described as text', async ({ page }) => {
  const label = shape(
    't',
    10,
    10,
    80,
    25,
    {
      text: 'Hello board',
      originalText: 'Hello board',
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
  await openDrawing(page, scene([shape('f1', 0, 0, 400, 300, { name: 'Intro' }, 'frame'), label]));
  await runCommand(page, 'describe the drawing as text');
  const dialog = page.getByRole('dialog', { name: 'Description of the drawing' });
  await expect(dialog).toContainText('1 frame(s)');
  await expect(dialog.getByRole('region', { name: 'Frames (slides) in order' })).toContainText(
    'Intro',
  );
  await expect(dialog.getByRole('region', { name: 'Texts, top to bottom' })).toContainText(
    'Hello board',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
