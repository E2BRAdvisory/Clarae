import type { Page } from '@playwright/test';
import { expect, test, appOrigin, openVault, skipOnWeb } from './support';

// The 3D graph (M18-D): three.js draws in WebGL2, which headless Chromium gives through SwiftShader.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

/** What the E2E build exposes of the scene (graph/three/scene.ts). */
interface Probe {
  lod(): string;
  nodes(): number;
  drawCalls(): number;
  contextLost(): boolean;
  rendered(): number;
  pageOf(index: number): { x: number; y: number } | null;
}
/** Asks the scene on the page (null when there is none). */
function probe<K extends keyof Probe>(
  page: Page,
  method: K,
  ...args: Parameters<Probe[K]>
): Promise<ReturnType<Probe[K]> | null> {
  return page.evaluate(
    ({ method, args }) => {
      const p = (window as unknown as { __graph3d?: Record<string, (...a: unknown[]) => unknown> })
        .__graph3d;
      return p ? p[method]!(...args) : null;
    },
    { method, args: args as unknown[] },
  ) as Promise<ReturnType<Probe[K]> | null>;
}
/** Whether no frame was drawn in the last 400 ms: the scene is at rest, the library's loop paused. */
const still = (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const frames = (): number =>
      (window as unknown as { __graph3d?: { rendered(): number } }).__graph3d?.rendered() ?? -1;
    const before = frames();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return before >= 0 && frames() === before;
  });
/** Resolves once the scene has stopped rendering: the camera and the layout are at rest. */
const atRest = (page: Page): Promise<void> =>
  expect.poll(() => still(page), { timeout: 20_000 }).toBe(true);

// Two notes that link each other, a third one, a canvas and a drawing that link notes from a text.
const VAULT = {
  'Alpha.md': '[[Beta]] [[Gamma]]',
  'Beta.md': '[[Gamma]] [[Alpha]]',
  'Gamma.md': 'end',
  'Board.canvas': JSON.stringify({
    nodes: [{ id: 't', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'see [[Alpha]]' }],
    edges: [],
  }),
  'Sketch.excalidraw': JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'clarae',
    elements: [{ id: 't', type: 'text', text: 'see [[Beta]]' }],
    appState: {},
    files: {},
  }),
};

/** Opens the graph of the vault and switches it to 3D; resolves once the layout has settled. */
async function open3D(page: Page) {
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  await page.getByTestId('graph-mode').click();
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  return scene;
}

test('the graph switches to 3D: a lazy chunk, a WebGL scene, the kinds of document, nothing from outside', async ({
  page,
}) => {
  const external: string[] = [];
  const scripts: string[] = [];
  const origin = appOrigin();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== origin)
      external.push(r.url());
    if (u.pathname.endsWith('.js')) scripts.push(u.pathname.split('/').pop() ?? '');
  });
  await openVault(page, VAULT);
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  // Drawings and canvases are nodes of the 2D graph too, with the links they hold.
  await expect(page.getByText('5 nodes, 6 links')).toBeVisible();
  // three.js is not part of what the graph view loads.
  expect(scripts.filter((s) => /^Graph3D/.test(s))).toEqual([]);

  await page.getByTestId('graph-mode').click();
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-graph-mode', '3d');
  await expect(scene).toHaveAttribute('data-graph-lod', 'sprite');
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
  expect(scripts.some((s) => /^Graph3D/.test(s))).toBe(true);
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await expect(page.getByText('5 nodes, 6 links')).toBeVisible();

  // The scene is a WebGL2 canvas that drew the nodes and the links.
  expect(await probe(page, 'nodes')).toBe(5);
  expect(await probe(page, 'contextLost')).toBe(false);
  await expect.poll(() => probe(page, 'drawCalls')).toBeGreaterThan(0);

  // The legend names the kinds of document in the graph.
  const legend = page.getByRole('list', { name: 'Kinds of document' });
  await expect(legend.getByText('Notes')).toBeVisible();
  await expect(legend.getByText('Drawings')).toBeVisible();
  await expect(legend.getByText('Canvases')).toBeVisible();

  // At rest no frame is drawn; the pointer wakes the scene.
  await atRest(page);
  const drawn = (await probe(page, 'rendered')) ?? 0;
  const box = await scene.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 120);
  await expect.poll(() => probe(page, 'rendered')).toBeGreaterThan(drawn);

  // The choice is this device's: it is not written in the vault.
  expect(await page.evaluate(() => localStorage.getItem('clarae.graph.mode'))).toBe('3d');
  expect(external).toEqual([]);

  // Back to 2D: the scene is gone and its WebGL context was given back, not left to the collector.
  await scene.locator('canvas').evaluate((c) => {
    (window as unknown as { __closed?: Element }).__closed = c;
  });
  await page.getByTestId('graph-mode').click();
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  await expect(scene).toHaveCount(0);
  expect(await probe(page, 'nodes')).toBeNull();
  expect(
    await page.evaluate(() => {
      const c = (window as unknown as { __closed: HTMLCanvasElement }).__closed;
      return c.isConnected ? 'still in the page' : c.getContext('webgl2')?.isContextLost();
    }),
  ).toBe(true);
});

test('in 3D a click selects a node, a second one opens it, and the keyboard does the same', async ({
  page,
}) => {
  await openVault(page, VAULT);
  const scene = await open3D(page);
  // The camera has fitted the graph: wait for it to rest before aiming at a node.
  await atRest(page);
  const at = await probe(page, 'pageOf', 0);
  expect(at).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  const current = scene.locator('.graph3d-label.current');
  await expect(current).toBeVisible();
  const name = (await current.textContent()) ?? '';
  expect(name).not.toBe('');
  // The camera flew to the node, which is now in the middle of the scene: selected, not just
  // under the pointer (its name stays lit with the pointer elsewhere).
  await atRest(page);
  const box = await scene.boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + box!.height - 30);
  const again = await probe(page, 'pageOf', 0);
  expect(Math.abs(again!.x - (box!.x + box!.width / 2))).toBeLessThan(4);
  expect(Math.abs(again!.y - (box!.y + box!.height / 2))).toBeLessThan(4);
  await expect(current).toHaveText(name);
  // A second click on the selected node opens it.
  await page.mouse.click(again!.x, again!.y);
  await expect(page.getByRole('tab', { name: new RegExp(name) }).first()).toBeVisible();

  // Keyboard: the graph again (3D is remembered), walk to the most connected node and open it.
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await scene.focus();
  await expect(current).toHaveCount(0);
  await page.keyboard.press(']');
  await expect(current).toBeVisible();
  const walked = (await current.textContent()) ?? '';
  expect(['Alpha', 'Beta']).toContain(walked);
  await page.keyboard.press('Escape');
  await expect(current).toHaveCount(0);
  await page.keyboard.press(']');
  await expect(current).toHaveText(walked);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: new RegExp(walked) }).first()).toBeVisible();
});

test('in 3D a node the timelapse hides is neither picked nor opened', async ({ page }) => {
  await openVault(page, VAULT);
  const scene = await open3D(page);
  await atRest(page);
  const at = await probe(page, 'pageOf', 0);
  const current = scene.locator('.graph3d-label.current');
  // The start of the timelapse: no node is shown yet, and none answers the pointer.
  await page.getByLabel('Timelapse position').fill('0');
  await expect(scene.locator('.graph3d-label:not([hidden])')).toHaveCount(0);
  await page.mouse.click(at!.x, at!.y);
  await page.mouse.click(at!.x, at!.y);
  await atRest(page);
  await expect(current).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Graph view' })).toBeVisible();
  // Nor is it dragged: the gesture turns the camera, and no node is left held.
  await page.mouse.move(at!.x, at!.y);
  await page.mouse.down();
  await page.mouse.move(at!.x + 50, at!.y + 30, { steps: 5 });
  await page.mouse.up();
  await atRest(page);
  await expect(page.getByRole('button', { name: /Release the nodes/ })).toHaveCount(0);
  // The end of it: the node is there again and takes the click.
  await page.getByLabel('Timelapse position').fill('1000');
  await atRest(page);
  const back = await probe(page, 'pageOf', 0);
  await page.mouse.click(back!.x, back!.y);
  await expect(current).toBeVisible();
});

test('in 3D a dragged node stays where it is dropped until the nodes are released', async ({
  page,
}) => {
  await openVault(page, VAULT);
  const scene = await open3D(page);
  await atRest(page);
  const from = await probe(page, 'pageOf', 0);
  await page.mouse.move(from!.x, from!.y);
  await page.mouse.down();
  await page.mouse.move(from!.x + 60, from!.y + 40, { steps: 6 });
  await page.mouse.up();
  const release = page.getByRole('button', { name: 'Release the nodes held in place (1)' });
  await expect(release).toBeVisible();
  await atRest(page);
  const dropped = await probe(page, 'pageOf', 0);
  expect(Math.hypot(dropped!.x - from!.x, dropped!.y - from!.y)).toBeGreaterThan(30);

  // The layout runs again (a force changes): the others move, the held node does not spring back.
  await page.getByText('Forces', { exact: true }).click();
  await page.getByLabel('Link distance').fill('60');
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await atRest(page);
  const held = await probe(page, 'pageOf', 0);
  expect(Math.hypot(held!.x - dropped!.x, held!.y - dropped!.y)).toBeLessThan(3);

  // Released, it goes back among its neighbours.
  await release.click();
  await expect(release).toHaveCount(0);
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await atRest(page);
  const free = await probe(page, 'pageOf', 0);
  expect(Math.hypot(free!.x - dropped!.x, free!.y - dropped!.y)).toBeGreaterThan(3);
});

test('the ribbon opens the graph in 3D, and without WebGL2 the graph stays in 2D with a notice', async ({
  page,
}) => {
  await openVault(page, VAULT);
  await page.getByRole('button', { name: 'Open graph view in 3D' }).click();
  await expect(page.getByTestId('graph-3d')).toBeVisible();

  // A device without WebGL2: same vault, same choice, the 2D canvas and the reason.
  await page.addInitScript(() => {
    const canvas = HTMLCanvasElement.prototype as unknown as {
      getContext: (this: HTMLCanvasElement, kind: string) => unknown;
    };
    const original = canvas.getContext;
    canvas.getContext = function (kind) {
      return kind === 'webgl2' ? null : original.call(this, kind);
    };
  });
  await openVault(page, VAULT);
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  await expect(page.getByTestId('graph-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'WebGL2' })).toBeVisible();
  await expect(page.getByTestId('graph-3d')).toHaveCount(0);
});

test('the 3D context is given back when the scene closes, and a lost one leaves the graph in 2D', async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (/too many active webgl contexts|context lost/i.test(m.text())) warnings.push(m.text());
  });
  await openVault(page, VAULT);
  const scene = await open3D(page);
  // More scenes than a page may hold contexts (about sixteen): each one must release its own.
  const mode = page.getByTestId('graph-mode');
  for (let i = 0; i < 20; i++) {
    await mode.click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await mode.click();
    await expect(scene).toBeVisible();
  }
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  expect(await probe(page, 'contextLost')).toBe(false);
  await expect.poll(() => probe(page, 'drawCalls')).toBeGreaterThan(0);
  expect(warnings).toEqual([]);

  // The GPU takes the context back: the graph goes on in 2D and says why.
  await scene.locator('canvas').evaluate((c: HTMLCanvasElement) => {
    c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'context was lost' })).toBeVisible();
  await expect(page.getByText('5 nodes, 6 links')).toBeVisible();
  // Asking for 3D again is another try.
  await mode.click();
  await mode.click();
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
});

test('a large graph is drawn as points, a few draw calls for all the nodes, and its nodes are still picked', async ({
  page,
}) => {
  skipOnWeb(
    'graph.3d',
    'the synthetic graph comes from the Wails mock (window.__CLARAE_GRAPH_FIXTURE__)',
  );
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>)['__CLARAE_GRAPH_FIXTURE__'] = 3000;
  });
  await openVault(page);
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await page.getByTestId('graph-mode').click();
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toHaveAttribute('data-graph-lod', 'points');
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 90_000 });
  expect(await probe(page, 'nodes')).toBe(3000);
  // Not an object per node or per link: the nodes of a look are one draw call, the links one.
  await expect.poll(() => probe(page, 'drawCalls')).toBeGreaterThan(0);
  expect(await probe(page, 'drawCalls')).toBeLessThan(20);

  // A click on a point selects it and nothing more: the tab is still the graph.
  await atRest(page);
  const point = await probe(page, 'pageOf', 37);
  await page.mouse.click(point!.x, point!.y);
  const picked = scene.locator('.graph3d-label.current');
  await expect(picked).toBeVisible();
  await atRest(page);
  await expect(page.getByRole('tab', { name: 'Graph view' })).toBeVisible();
  await expect(scene).toBeVisible();

  // Walk to the most connected node, then pick it with the pointer: a click on it opens it.
  await page.mouse.move(100, 300); // off the scene: the name is that of the selection, not of a hover
  await expect(picked).toBeVisible();
  await scene.focus();
  await page.keyboard.press('Escape');
  await expect(picked).toHaveCount(0);
  await page.keyboard.press(']');
  const current = scene.locator('.graph3d-label.current');
  await expect(current).toBeVisible();
  const name = (await current.textContent()) ?? '';
  await atRest(page);
  const box = await scene.boundingBox();
  // The camera looks at the node it flew to: it is in the middle of the scene.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  // The synthetic note "Note 10" is the file n10.md.
  await expect(
    page.getByRole('tab', { name: name.replace('Note ', 'n'), exact: true }),
  ).toBeVisible();
});
