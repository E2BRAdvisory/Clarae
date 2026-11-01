import type { Page } from '@playwright/test';
import { appOrigin, expect, listVaultFiles, openVault, readVaultFile, test } from './support';

const SKETCH = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'memobrain',
  elements: [
    {
      id: 'box1',
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 160,
      height: 90,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      index: 'a0',
    },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
});

/** Fails the test when the page asks for anything outside the app itself (M3 offline gate). */
function watchNetwork(page: Page): { external: string[]; assets: number } {
  const seen = { external: [] as string[], assets: 0 };
  const origin = appOrigin();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== origin) seen.external.push(req.url());
    if (url.pathname.startsWith('/excalidraw-assets/')) seen.assets++;
  });
  return seen;
}

const fileOf = (page: Page, path: string) => readVaultFile(page, path);

test('a drawing opens, saves edits and makes no request outside the app', async ({ page }) => {
  const net = watchNetwork(page);
  await openVault(page, { 'Sketch.excalidraw': SKETCH });
  await page.locator('.tree .node', { hasText: 'Sketch' }).click();

  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible({ timeout: 60_000 });

  // Draw a second rectangle: R is the rectangle tool.
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 300, y: 450 } });
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 380, { steps: 6 });
  await page.mouse.up();

  // Autosave runs 2 s after the edit.
  await expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 15_000 });
  await expect
    .poll(
      async () =>
        (JSON.parse(await fileOf(page, 'Sketch.excalidraw')) as { elements: unknown[] }).elements
          .length,
    )
    .toBe(2);

  // Fonts come from the app itself; nothing leaves it.
  expect(net.external).toEqual([]);
});

test('a drawing embedded in a note renders from its preview', async ({ page }) => {
  const net = watchNetwork(page);
  await openVault(page, {
    'Sketch.excalidraw': SKETCH,
    'Note.md': '# Note\n\n![[Sketch.excalidraw|300]]\n',
  });
  await page.locator('.tree .node', { hasText: 'Note' }).click();
  await page.getByRole('button', { name: 'Reading' }).click();
  const img = page.locator('img.embed-drawing');
  await expect(img).toBeVisible({ timeout: 60_000 });
  await expect(img).toHaveAttribute('width', '300');
  expect(net.external).toEqual([]);
});

test('New drawing and New canvas are in the file explorer menu', async ({ page }) => {
  await openVault(page, { 'Folder/Note.md': 'x' });
  await page.locator('.tree .node', { hasText: 'Folder' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New drawing' }).click();
  await expect(page.getByRole('tab', { name: /Drawing \d{4}.*excalidraw/ })).toBeVisible();
  await expect
    .poll(async () =>
      (await listVaultFiles(page)).some((p) => /^Folder\/Drawing .*\.excalidraw$/.test(p)),
    )
    .toBe(true);

  await page.locator('.tree .node', { hasText: 'Folder' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New canvas' }).click();
  await expect(page.getByRole('tab', { name: /Canvas \d{4}.*canvas/ })).toBeVisible();
});

test('app dialogs stay above an open drawing', async ({ page }) => {
  await openVault(page, { 'Sketch.excalidraw': SKETCH });
  await page.locator('.tree .node', { hasText: 'Sketch' }).click();
  await expect(page.locator('.drawing-canvas .excalidraw canvas.interactive')).toBeVisible({
    timeout: 60_000,
  });

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.locator('.modal').first();
  await expect(dialog).toBeVisible();
  // The element under the dialog's centre must belong to the dialog, not to Excalidraw's UI.
  const onTop = await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
  expect(onTop).toBe(true);
  // So must its left edge, where Excalidraw's toolbar and menus sit.
  const leftOnTop = await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 20, r.top + 60);
    return !!hit && el.contains(hit);
  });
  expect(leftOnTop).toBe(true);
});

test('Present toggles: it hides Excalidraw’s icons and Escape shows them again', async ({
  page,
}) => {
  await openVault(page, { 'Sketch.excalidraw': SKETCH });
  await page.locator('.tree .node', { hasText: 'Sketch' }).click();
  await expect(page.locator('.drawing-canvas .excalidraw canvas.interactive')).toBeVisible({
    timeout: 60_000,
  });
  const chrome = page.locator('.drawing-canvas .excalidraw .App-top-bar');
  const present = page.getByRole('button', { name: 'Present' });

  await expect(chrome).toBeVisible();
  await expect(present).toHaveAttribute('aria-pressed', 'false');

  await present.click();
  await expect(present).toHaveAttribute('aria-pressed', 'true');
  await expect(chrome).toBeHidden();

  // The presentation covers the window (header included): Escape ends it.
  await page.keyboard.press('Escape');
  await expect(present).toHaveAttribute('aria-pressed', 'false');
  await expect(chrome).toBeVisible();

  // Escape ends a presentation too.
  await present.click();
  await expect(chrome).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(present).toHaveAttribute('aria-pressed', 'false');
  await expect(chrome).toBeVisible();
});
