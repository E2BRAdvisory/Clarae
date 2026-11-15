import type { Page } from '@playwright/test';
import { expect, test, appOrigin, openVault, seedVault, skipOnWeb } from './support';

// The 3D graph (M18-D): three.js draws in WebGL2, which headless Chromium gives through SwiftShader.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

/**
 * What waits on the scene (its lazy chunk, a frame, a label, a held node, a tab opened by a click on a
 * node) is given longer than the 5 s of the default: under load, with a software rasteriser, they are late.
 */
const SLOW = { timeout: 20_000 };

/** What the E2E build exposes of the scene (graph/three/scene.ts). */
interface Probe {
  lod(): string;
  nodes(): number;
  drawCalls(): number;
  solids(): { shape: string; nodes: number }[];
  contextLost(): boolean;
  rendered(): number;
  asleep(): boolean;
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
/**
 * Whether the scene is at rest: the library's loop paused, and no frame was drawn in the last 400 ms.
 * Frames alone are not enough under load, where a late frame looks like a pause in the middle of a
 * camera move; the scene says itself that it has gone to sleep and nothing is waiting to wake it.
 */
const still = (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const p = (window as unknown as { __graph3d?: { rendered(): number; asleep(): boolean } })
      .__graph3d;
    const before = p?.rendered() ?? -1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return before >= 0 && p?.rendered() === before && p.asleep();
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
  await expect(page.getByTestId('graph-canvas')).toBeVisible(SLOW);
  await page.getByTestId('graph-mode').click();
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toBeVisible(SLOW);
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
  await expect(page.getByTestId('graph-canvas')).toBeVisible(SLOW);
  // Drawings and canvases are nodes of the 2D graph too, with the links they hold.
  await expect(page.getByText('5 nodes, 6 links')).toBeVisible(SLOW);
  // three.js is not part of what the graph view loads.
  expect(scripts.filter((s) => /^Graph3D/.test(s))).toEqual([]);

  await page.getByTestId('graph-mode').click();
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toBeVisible(SLOW);
  await expect(scene).toHaveAttribute('data-graph-mode', '3d');
  await expect(scene).toHaveAttribute('data-graph-lod', 'sprite');
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
  expect(scripts.some((s) => /^Graph3D/.test(s))).toBe(true);
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await expect(page.getByText('5 nodes, 6 links')).toBeVisible(SLOW);

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
  await expect(page.getByTestId('graph-canvas')).toBeVisible(SLOW);
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
  await expect(current).toBeVisible(SLOW);
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
  await expect(current).toHaveText(name, SLOW);
  // A second click on the selected node opens it.
  await page.mouse.click(again!.x, again!.y);
  await expect(page.getByRole('tab', { name: new RegExp(name) }).first()).toBeVisible(SLOW);

  // Keyboard: the graph again (3D is remembered), walk to the most connected node and open it.
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await scene.focus();
  await expect(current).toHaveCount(0);
  await page.keyboard.press(']');
  await expect(current).toBeVisible(SLOW);
  const walked = (await current.textContent()) ?? '';
  expect(['Alpha', 'Beta']).toContain(walked);
  await page.keyboard.press('Escape');
  await expect(current).toHaveCount(0);
  await page.keyboard.press(']');
  await expect(current).toHaveText(walked, SLOW);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: new RegExp(walked) }).first()).toBeVisible(SLOW);
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
  await expect(current).toBeVisible(SLOW);
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
  await expect(release).toBeVisible(SLOW);
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

/**
 * Draws the nodes as solids whatever their number (E2E builds only: window.__CLARAE_GRAPH3D_LOD__),
 * so the instanced level is tried on the small vault; the size that calls for it is tried below.
 */
async function asSolids(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>)['__CLARAE_GRAPH3D_LOD__'] = 'instanced';
  });
}

test('in 3D solids stand for the kinds of document: a draw call each, and a click selects and a second one opens', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await asSolids(page);
  await openVault(page, VAULT);
  const scene = await open3D(page);
  await expect(scene).toHaveAttribute('data-graph-lod', 'instanced');
  // A sphere for the three notes, a cube for the drawing, an octahedron for the canvas.
  expect(await probe(page, 'solids')).toEqual([
    { shape: 'sphere', nodes: 3 },
    { shape: 'cube', nodes: 1 },
    { shape: 'octahedron', nodes: 1 },
  ]);
  await expect.poll(() => probe(page, 'drawCalls')).toBeGreaterThan(0);
  // One draw call per solid and one for all the links: not an object per node.
  expect(await probe(page, 'drawCalls')).toBeLessThanOrEqual(3 + 1);
  // The legend shows the solid of each kind where it showed the icon.
  const legend = page.getByRole('list', { name: 'Kinds of document' });
  await expect(legend.locator('[data-shape="sphere"]')).toHaveCount(1);
  await expect(legend.locator('[data-shape="cube"]')).toHaveCount(1);
  await expect(legend.locator('[data-shape="octahedron"]')).toHaveCount(1);

  // A click on a solid selects it, flies to it and lights its neighbourhood; a second click opens it.
  await atRest(page);
  const at = await probe(page, 'pageOf', 0);
  await page.mouse.click(at!.x, at!.y);
  const current = scene.locator('.graph3d-label.current');
  await expect(current).toBeVisible(SLOW);
  const name = (await current.textContent()) ?? '';
  await atRest(page);
  await expect(page.getByRole('tab', { name: 'Graph view' })).toBeVisible();
  const box = await scene.boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + box!.height - 30);
  const again = await probe(page, 'pageOf', 0);
  expect(Math.abs(again!.x - (box!.x + box!.width / 2))).toBeLessThan(4);
  expect(Math.abs(again!.y - (box!.y + box!.height / 2))).toBeLessThan(4);
  await expect(current).toHaveText(name, SLOW);
  await page.mouse.click(again!.x, again!.y);
  await expect(page.getByRole('tab', { name: new RegExp(name) }).first()).toBeVisible(SLOW);

  // A click on the background lets the selection go.
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await atRest(page);
  const first = await probe(page, 'pageOf', 1);
  await page.mouse.click(first!.x, first!.y);
  await expect(current).toBeVisible(SLOW);
  await atRest(page);
  const b = await scene.boundingBox();
  await page.mouse.click(b!.x + 8, b!.y + b!.height / 2);
  await expect(current).toHaveCount(0);
});

test('in 3D a solid the timelapse hides is neither picked nor held, and one dragged stays until released', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await asSolids(page);
  await openVault(page, VAULT);
  const scene = await open3D(page);
  await atRest(page);
  const from = await probe(page, 'pageOf', 0);
  const current = scene.locator('.graph3d-label.current');

  // The start of the timelapse: no solid is shown, and none answers the pointer.
  await page.getByLabel('Timelapse position').fill('0');
  await atRest(page);
  await page.mouse.click(from!.x, from!.y);
  await page.mouse.click(from!.x, from!.y);
  await atRest(page);
  await expect(current).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Graph view' })).toBeVisible();
  await page.mouse.move(from!.x, from!.y);
  await page.mouse.down();
  await page.mouse.move(from!.x + 50, from!.y + 30, { steps: 5 });
  await page.mouse.up();
  await atRest(page);
  await expect(page.getByRole('button', { name: /Release the nodes/ })).toHaveCount(0);
  await page.getByLabel('Timelapse position').fill('1000');
  await atRest(page);

  // Dragged: the node goes where the pointer takes it, and the camera did not turn.
  const grab = await probe(page, 'pageOf', 0);
  const other = await probe(page, 'pageOf', 1);
  await page.mouse.move(grab!.x, grab!.y);
  await page.mouse.down();
  await page.mouse.move(grab!.x + 60, grab!.y + 40, { steps: 6 });
  await page.mouse.up();
  const release = page.getByRole('button', { name: 'Release the nodes held in place (1)' });
  await expect(release).toBeVisible(SLOW);
  await atRest(page);
  const dropped = await probe(page, 'pageOf', 0);
  expect(Math.hypot(dropped!.x - grab!.x - 60, dropped!.y - grab!.y - 40)).toBeLessThan(6);
  // The drag was not a click: nothing is selected (the name shown while the pointer is on the node
  // is the hover's), no tab opened.
  const box = await scene.boundingBox();
  await page.mouse.move(box!.x + 30, box!.y + box!.height - 30);
  await expect(current).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Graph view' })).toBeVisible();
  // The other solids did not move with the camera: only the node did.
  const otherNow = await probe(page, 'pageOf', 1);
  expect(Math.hypot(otherNow!.x - other!.x, otherNow!.y - other!.y)).toBeLessThan(40);

  // The layout runs again: the held node does not spring back.
  await page.getByText('Forces', { exact: true }).click();
  await page.getByLabel('Link distance').fill('60');
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await atRest(page);
  const held = await probe(page, 'pageOf', 0);
  expect(Math.hypot(held!.x - dropped!.x, held!.y - dropped!.y)).toBeLessThan(3);
  await release.click();
  await expect(release).toHaveCount(0);
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await atRest(page);
  const free = await probe(page, 'pageOf', 0);
  expect(Math.hypot(free!.x - dropped!.x, free!.y - dropped!.y)).toBeGreaterThan(3);
});

test('a solid held while the graph changes lets go, and the camera still turns afterwards', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await asSolids(page);
  await openVault(page, VAULT);
  const scene = await open3D(page);
  await atRest(page);
  const box = (await scene.boundingBox())!;
  /** A drag on the background, away from the nodes: it turns the camera. Returns how far node 1 went. */
  const turn = async (): Promise<number> => {
    const before = (await probe(page, 'pageOf', 1))!;
    await page.mouse.move(box.x + box.width - 80, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 300, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    await atRest(page);
    const after = (await probe(page, 'pageOf', 1))!;
    return Math.hypot(after.x - before.x, after.y - before.y);
  };
  expect(await turn()).toBeGreaterThan(5);

  // Hold a solid, and while it is held a note is created: the graph is built again.
  const at = (await probe(page, 'pageOf', 0))!;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y + 20, { steps: 4 });
  await seedVault(page, { files: { 'Delta.md': '# Delta\n[[Alpha]]\n' } });
  await expect.poll(() => probe(page, 'nodes'), { timeout: 30_000 }).toBe(6);
  await page.mouse.move(at.x + 40, at.y + 30, { steps: 2 });
  await page.mouse.up();
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  await atRest(page);

  // The controls of the camera came back with the new graph: the same drag turns the view again.
  expect(await turn()).toBeGreaterThan(5);
});

test('the ribbon opens the graph in 3D, and without WebGL2 the graph stays in 2D with a notice', async ({
  page,
}) => {
  await openVault(page, VAULT);
  await page.getByRole('button', { name: 'Open graph view in 3D' }).click();
  await expect(page.getByTestId('graph-3d')).toBeVisible(SLOW);

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
  await expect(page.getByTestId('graph-canvas')).toBeVisible(SLOW);
  await expect(page.getByTestId('graph-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'WebGL2' })).toBeVisible(SLOW);
  await expect(page.getByTestId('graph-3d')).toHaveCount(0);
});

/** Scenes opened after the first one: 1 + 17 = 18 contexts, over the 16 a page may hold. */
const SCENES = 17;

test('the 3D context is given back when the scene closes, and a lost one leaves the graph in 2D', async ({
  page,
}) => {
  // Each round trip builds a WebGL scene, which takes seconds under load (23 to 56 s in all).
  test.setTimeout(180_000);
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (/too many active webgl contexts|context lost/i.test(m.text())) warnings.push(m.text());
  });
  await openVault(page, VAULT);
  const scene = await open3D(page);
  // More scenes than a page may hold contexts (Chromium keeps sixteen): the first one and SCENES
  // more are eighteen, two over, so a context that was not given back would show as a warning.
  const mode = page.getByTestId('graph-mode');
  for (let i = 0; i < SCENES; i++) {
    await mode.click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible(SLOW);
    await mode.click();
    await expect(scene).toBeVisible(SLOW);
  }
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
  expect(await probe(page, 'contextLost')).toBe(false);
  await expect.poll(() => probe(page, 'drawCalls')).toBeGreaterThan(0);
  expect(warnings).toEqual([]);

  // The GPU takes the context back: the graph goes on in 2D and says why.
  await scene.locator('canvas').evaluate((c: HTMLCanvasElement) => {
    c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await expect(page.getByTestId('graph-canvas')).toBeVisible(SLOW);
  await expect(page.getByRole('status').filter({ hasText: 'context was lost' })).toBeVisible(SLOW);
  await expect(page.getByText('5 nodes, 6 links')).toBeVisible(SLOW);
  // Asking for 3D again is another try.
  await mode.click();
  await mode.click();
  await expect(scene).toBeVisible(SLOW);
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 30_000 });
});

test('a graph of more than a thousand nodes is drawn as solids, a draw call for each kind, and its nodes are picked', async ({
  page,
}) => {
  skipOnWeb(
    'graph.3d',
    'the synthetic graph comes from the Wails mock (window.__CLARAE_GRAPH_FIXTURE__)',
  );
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w['__CLARAE_GRAPH_FIXTURE__'] = 1500;
    w['__CLARAE_GRAPH_KINDS__'] = true; // notes, drawings, canvases, bases, attachments, tags, ghosts
  });
  await openVault(page);
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await page.getByTestId('graph-mode').click();
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toHaveAttribute('data-graph-lod', 'instanced');
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 90_000 });
  expect(await probe(page, 'nodes')).toBe(1500);

  // A solid for each kind of document in the graph, all the nodes in them.
  const solids = (await probe(page, 'solids')) ?? [];
  const shapes = solids.map((g) => g.shape);
  for (const shape of [
    'sphere',
    'cube',
    'octahedron',
    'cylinder',
    'cone',
    'torus',
    'icosahedron',
  ]) {
    expect(shapes).toContain(shape);
  }
  expect(solids.reduce((n, g) => n + g.nodes, 0)).toBe(1500);
  // A draw call for each solid and one for all the links: not one for each of 1.500 nodes.
  await expect.poll(() => probe(page, 'drawCalls')).toBeGreaterThan(0);
  expect(await probe(page, 'drawCalls')).toBeLessThanOrEqual(solids.length + 1);
  // The legend draws each kind as its solid.
  const legend = page.getByRole('list', { name: 'Kinds of document' });
  await expect(legend.locator('svg[data-shape]')).toHaveCount(await legend.locator('li').count());

  // A click on a solid selects it and nothing more: the tab is still the graph.
  await atRest(page);
  const at = await probe(page, 'pageOf', 37);
  await page.mouse.click(at!.x, at!.y);
  await expect(scene.locator('.graph3d-label.current')).toBeVisible(SLOW);
  await atRest(page);
  await expect(page.getByRole('tab', { name: 'Graph view' })).toBeVisible();
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
  await expect(picked).toBeVisible(SLOW);
  await atRest(page);
  await expect(page.getByRole('tab', { name: 'Graph view' })).toBeVisible();
  await expect(scene).toBeVisible(SLOW);

  // Walk to the most connected node, then pick it with the pointer: a click on it opens it.
  await page.mouse.move(100, 300); // off the scene: the name is that of the selection, not of a hover
  await expect(picked).toBeVisible(SLOW);
  await scene.focus();
  await page.keyboard.press('Escape');
  await expect(picked).toHaveCount(0);
  await page.keyboard.press(']');
  const current = scene.locator('.graph3d-label.current');
  await expect(current).toBeVisible(SLOW);
  const name = (await current.textContent()) ?? '';
  await atRest(page);
  const box = await scene.boundingBox();
  // The camera looks at the node it flew to: it is in the middle of the scene.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  // The synthetic note "Note 10" is the file n10.md.
  await expect(
    page.getByRole('tab', { name: name.replace('Note ', 'n'), exact: true }),
  ).toBeVisible(SLOW);
});
