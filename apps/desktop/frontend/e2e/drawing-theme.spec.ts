// Drawings and the theme: with the app on "system" the editor follows the operating system while
// it is open, and a drawing embedded in a note is shown in the picture of the theme in force.
import type { Page } from '@playwright/test';
import { expect, openVault, test } from './support';
import { openDrawing, scene, shape, watchNetwork } from './drawingHelpers';

// Offline gate: nothing here may reach outside the app itself.
let external: string[] = [];
test.beforeEach(({ page }) => {
  external = watchNetwork(page);
});
test.afterEach(() => {
  expect(external).toEqual([]);
});

const BOARD = scene([
  shape('a', 0, 0, 160, 90, { backgroundColor: '#ffc9c9', fillStyle: 'solid' }),
]);

/** The SVG behind an <img> of the page (a blob URL of the app itself). */
const pictureOf = (page: Page, src: string): Promise<string> =>
  page.evaluate(async (url) => (await fetch(url)).text(), src);

test('the editor follows the operating system when the theme is "system"', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openDrawing(page, BOARD);
  const editor = page.locator('.drawing-canvas .excalidraw');
  await expect(editor).not.toHaveClass(/theme--dark/);

  // The OS goes dark while the drawing is open: no reload, no reopening.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(editor).toHaveClass(/theme--dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(editor).not.toHaveClass(/theme--dark/);

  // A theme chosen in the app is not the system's to change.
  await page.getByRole('button', { name: /theme/i }).first().click();
  const fixed = (await editor.getAttribute('class'))?.includes('theme--dark') ?? false;
  await page.emulateMedia({ colorScheme: fixed ? 'light' : 'dark' });
  await page.waitForTimeout(300);
  expect((await editor.getAttribute('class'))?.includes('theme--dark') ?? false).toBe(fixed);
});

test('a drawing embedded in a note is shown in the picture of the theme in force', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openVault(page, {
    'Board.excalidraw': BOARD,
    'Note.md': '# Note\n\n![[Board.excalidraw|300]]\n',
  });
  await page.locator('.tree .node', { hasText: 'Note' }).click();
  await page.getByRole('button', { name: 'Reading' }).click();
  const img = page.locator('img.embed-drawing');
  await expect(img).toBeVisible({ timeout: 60_000 });
  const light = (await img.getAttribute('src'))!;
  const lightSvg = await pictureOf(page, light);

  // Dark: another picture of the same drawing, drawn for the dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(img).not.toHaveAttribute('src', light);
  const dark = (await img.getAttribute('src'))!;
  const darkSvg = await pictureOf(page, dark);
  expect(darkSvg).toContain('<svg');
  expect(darkSvg).not.toBe(lightSvg);

  // And back: the light picture is still at hand, not drawn again.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(img).toHaveAttribute('src', light);
});
