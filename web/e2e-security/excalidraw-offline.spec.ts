import { expect, test } from '@playwright/test';

// Excalidraw must work offline (spec §2.7.3): its fonts and assets come from the app itself, never from a
// CDN. The desktop suite checks it on the mocked bindings (apps/desktop/frontend/e2e/drawing.spec.ts); this
// is the gate that runs in CI, on the minified workbench under the production handler and policy, with the
// real core. The drawing has Chinese text, so Excalidraw has to load its CJK fallback font (Xiaolai) to
// render it: that font used to be fetched from a CDN (blocked by the CSP) instead of the app.
const ORIGIN = 'http://127.0.0.1:18096';

const SKETCH = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'clarae',
  elements: [
    {
      id: 'label1',
      type: 'text',
      x: 120,
      y: 120,
      width: 220,
      height: 35,
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
      text: 'Offline 离线草图',
      originalText: 'Offline 离线草图',
      fontSize: 28,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
});

test('a drawing opens with its fonts from the app, no request leaves it', async ({ page }) => {
  test.setTimeout(180_000);
  const foreign: string[] = [];
  const violations: string[] = [];
  const fonts: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    if (u.origin !== ORIGIN) foreign.push(r.url());
    if (u.pathname.startsWith('/excalidraw-assets/fonts/Xiaolai/')) fonts.push(u.pathname);
  });
  page.on('console', (m) => {
    if (/content security policy|refused to/i.test(m.text())) violations.push(m.text());
  });

  await page.goto(`${ORIGIN}/vaults/drawing/open?local`);
  await expect(page.locator('header.titlebar .title')).toHaveText('drawing', { timeout: 120_000 });

  // The drawing is written through the real core, then opened from the file tree like a user would.
  await page.evaluate(async (sketch) => {
    const app = (
      window as unknown as {
        go: { app: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
      }
    ).go.app;
    const [vault] = (await app['VaultAPI']!['ListOpen']!()) as { id: string }[];
    await app['VaultAPI']!['WriteNote']!(vault!.id, 'Sketch.excalidraw', sketch, '');
  }, SKETCH);
  await page.locator('.tree .node', { hasText: 'Sketch' }).click({ timeout: 60_000 });
  await expect(page.locator('.drawing-canvas .excalidraw canvas.interactive')).toBeVisible({
    timeout: 90_000,
  });
  // The CJK font of the text is fetched, from the app.
  await expect.poll(() => fonts.length, { timeout: 30_000 }).toBeGreaterThan(0);

  expect(foreign).toEqual([]);
  expect(violations).toEqual([]);
});

test('an altered excalidraw.js never runs', async ({ page }) => {
  test.setTimeout(180_000);
  // The classic script is added by a <script> tag that carries its SRI (workbench build): altered bytes
  // (a compromised cache or asset store) are refused, so the editor does not open.
  await page.route(/\/excalidraw-assets\/excalidraw\.js$/, async (route) => {
    const original = await route.fetch();
    await route.fulfill({ response: original, body: (await original.text()) + '\n;0;' });
  });
  const integrity: string[] = [];
  page.on('console', (m) => {
    if (/integrity/i.test(m.text())) integrity.push(m.text());
  });
  await page.goto(`${ORIGIN}/vaults/drawing-tampered/open?local`);
  await expect(page.locator('header.titlebar .title')).toHaveText('drawing-tampered', {
    timeout: 120_000,
  });
  await page.evaluate(async (sketch) => {
    const app = (
      window as unknown as {
        go: { app: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
      }
    ).go.app;
    const [vault] = (await app['VaultAPI']!['ListOpen']!()) as { id: string }[];
    await app['VaultAPI']!['WriteNote']!(vault!.id, 'Sketch.excalidraw', sketch, '');
  }, SKETCH);
  await page.locator('.tree .node', { hasText: 'Sketch' }).click({ timeout: 60_000 });
  await expect.poll(() => integrity.length, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => 'ExcalidrawLib' in globalThis)).toBe(false);
  await expect(page.locator('.drawing-canvas .excalidraw canvas.interactive')).toHaveCount(0);
});
