import { expect, test, type Page } from '@playwright/test';

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    emit(name: string, payload: unknown): void;
  };
}

const SKETCH = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'nodus',
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
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== 'http://localhost:5199') seen.external.push(req.url());
    if (url.pathname.startsWith('/excalidraw-assets/')) seen.assets++;
  });
  return seen;
}

async function openVault(page: Page, files: Record<string, string>): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await page.evaluate((seed) => {
    const w = window as unknown as MockWindow;
    const v = [...w.__mock.vaults.values()][0];
    if (!v) throw new Error('vault not open');
    for (const [p, c] of Object.entries(seed)) v.files.set(p, c);
    w.__mock.emit('vault:file-changed', { vaultId: v.info.id, paths: Object.keys(seed) });
  }, files);
}

const fileOf = (page: Page, path: string) =>
  page.evaluate((p) => {
    const w = window as unknown as MockWindow;
    return [...w.__mock.vaults.values()][0]?.files.get(p) ?? '';
  }, path);

test('a drawing opens, saves edits and makes no request outside the app', async ({ page }) => {
  const net = watchNetwork(page);
  await openVault(page, { 'Sketch.excalidraw': SKETCH });
  await page.locator('.tree .node', { hasText: 'Sketch' }).click();

  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible({ timeout: 60_000 });

  // Draw a second rectangle: R is the rectangle tool.
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 5, y: 5 } });
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
  const created = await page.evaluate(() => {
    const w = window as unknown as MockWindow;
    return [...(w.__mock.vaults.values().next().value?.files.keys() ?? [])];
  });
  expect(created.some((p) => /^Folder\/Drawing .*\.excalidraw$/.test(p))).toBe(true);

  await page.locator('.tree .node', { hasText: 'Folder' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New canvas' }).click();
  await expect(page.getByRole('tab', { name: /Canvas \d{4}.*canvas/ })).toBeVisible();
});
