import { expect, openVault, test } from './support';

// The quick switcher (Ctrl/Cmd+O) finds the files the application opens in a tab, not only the
// notes: whiteboards, bases and drawings (and applications, see webapp.spec.ts). Each one says what
// it is in the name of its option and opens in its own view. The core answers the search, so on the
// web the same spec runs on the Go core in WebAssembly.

const CANVAS = `${JSON.stringify({ nodes: [], edges: [] })}\n`;
const BASE = 'views:\n  - type: table\n    name: Table\n';
const DRAWING = `${JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} })}\n`;

const FILES = {
  'Notes/Road trip.md': '# Road trip\n',
  'Boards/Road board.canvas': CANVAS,
  'Views/Road view.base': BASE,
  'Draw/Road sketch.excalidraw': DRAWING,
  'Road.txt': 'not something the switcher opens',
};

const NAME = 'Find a file or create a note…';

test('finds a whiteboard by its name and opens it in a tab', async ({ page }) => {
  await openVault(page, FILES);
  await page.keyboard.press('ControlOrMeta+o');
  const input = page.getByRole('combobox', { name: NAME });
  await input.fill('board');
  const option = page.getByRole('option', { name: /Road board, Canvas/ });
  await expect(option).toContainText('Boards');
  await input.press('Enter');
  await expect(page.getByRole('tab', { name: /Road board/ })).toBeVisible();
  await expect(page.getByRole('application', { name: 'Canvas' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: NAME })).toBeHidden();
});

test('lists notes, a whiteboard, a base and a drawing by kind, and nothing else', async ({
  page,
}) => {
  await openVault(page, FILES);
  await page.keyboard.press('ControlOrMeta+o');
  await page.getByRole('combobox', { name: NAME }).fill('road');
  for (const name of [
    /Road trip, Note/,
    /Road board, Canvas/,
    /Road view, Base/,
    /Road sketch, Drawing/,
  ])
    await expect(page.getByRole('option', { name })).toBeVisible();
  // a text file is not opened by the switcher; the name "road" is still free for a note
  await expect(page.getByRole('option', { name: /Road\.txt/ })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Create "road"' })).toBeVisible();
});

test('a base opens in its tab with Mod-Enter, next to the tab that was open', async ({ page }) => {
  await openVault(page, FILES);
  await page.locator('.tree .node', { hasText: 'Notes' }).click();
  await page.locator('.tree .node', { hasText: 'Road trip' }).click();
  await expect(page.getByRole('tab', { name: /Road trip/ })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+o');
  const input = page.getByRole('combobox', { name: NAME });
  await input.fill('view');
  await expect(page.getByRole('option', { name: /Road view, Base/ })).toBeVisible();
  await input.press('ControlOrMeta+Enter');
  await expect(page.getByRole('tab', { name: /Road view/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Road trip/ })).toBeVisible();
});
