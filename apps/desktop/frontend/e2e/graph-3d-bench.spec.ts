// Benchmark of the 3D graph in real Chromium (headless). Skipped unless CLARAE_GRAPH3D_BENCH is
// set (a node count), so normal e2e runs are not slowed down:
//
//   CLARAE_GRAPH3D_BENCH=5000 CLARAE_GRAPH3D_GL=metal \
//     yarn workspace @clarae/desktop-frontend exec playwright test e2e/graph-3d-bench.spec.ts
//
// CLARAE_GRAPH3D_GL chooses the WebGL backend: `metal` (the GPU of a Mac), `swiftshader` (software,
// the default: what a machine without a GPU gives). CLARAE_GRAPH3D_KINDS=mixed makes the graph one
// of several kinds of document (notes, drawings, canvases, bases, attachments, tags, ghosts) instead
// of notes only, which is what tells the levels of detail apart. The synthetic graph comes from the
// Wails mock (window.__CLARAE_GRAPH_FIXTURE__); the layout runs in the real Web Worker, in three
// dimensions.
// See docs/qa/graph-3d-benchmark.md.
import { expect, skipOnWeb, test } from './support';

const N = Number(process.env['CLARAE_GRAPH3D_BENCH'] ?? 0);
const GL = process.env['CLARAE_GRAPH3D_GL'] === 'metal' ? 'metal' : 'swiftshader';
const KINDS = process.env['CLARAE_GRAPH3D_KINDS'] === 'mixed' ? 'mixed' : 'notes';
// CLARAE_GRAPH3D_LOD=sprite|instanced|points draws the nodes at that level whatever their number
// (E2E builds only); unset, the level is the one the number of nodes calls for.
const LOD = ['sprite', 'instanced', 'points'].includes(process.env['CLARAE_GRAPH3D_LOD'] ?? '')
  ? process.env['CLARAE_GRAPH3D_LOD']
  : '';

test.skip(!N, 'set CLARAE_GRAPH3D_BENCH=<nodes> to run the 3D graph benchmark');

skipOnWeb(
  'graph.3d',
  'the synthetic graph comes from the Wails mock (window.__CLARAE_GRAPH_FIXTURE__)',
);

test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: {
    args:
      GL === 'metal'
        ? ['--use-angle=metal', '--ignore-gpu-blocklist']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

interface Stats {
  frames: number[];
  layoutMs: number;
  nodes: number;
  edges: number;
  ticks: number;
}
interface Probe {
  lod(): string;
  drawCalls(): number;
  triangles(): number;
  takeFrames(): number[];
  takeRenders(): number[];
}

const summary = (xs: number[]): { n: number; median: number; p95: number; max: number } => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.floor(p * (s.length - 1))] ?? 0;
  return {
    n: s.length,
    median: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +at(1).toFixed(2),
  };
};

test(`3D graph of ${N} nodes (${KINDS}) on ${GL}: layout time and frame rate`, async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(
    ([n, kinds, lod]) => {
      const w = window as unknown as Record<string, unknown>;
      w['__CLARAE_GRAPH_FIXTURE__'] = n;
      w['__CLARAE_GRAPH_KINDS__'] = kinds === 'mixed';
      if (lod) w['__CLARAE_GRAPH3D_LOD__'] = lod;
      w['__graphStats'] = { frames: [], layoutMs: 0, nodes: 0, edges: 0, ticks: 0 };
      localStorage.setItem('clarae.graph.mode', '3d');
    },
    [N, KINDS, LOD] as const,
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  const t0 = Date.now();
  await page.keyboard.press('ControlOrMeta+Shift+g');
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toBeVisible({ timeout: 60_000 });
  const startupMs = Date.now() - t0;

  // Phase 1: while the worker lays the graph out (the scene redraws on every set of positions).
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 240_000 });
  const layoutWallMs = Date.now() - t0;
  const during = await page.evaluate(() => {
    const s = (window as unknown as { __graphStats: Stats }).__graphStats;
    const p = (window as unknown as { __graph3d: Probe }).__graph3d;
    return {
      layoutMs: s.layoutMs,
      posts: s.ticks,
      nodes: s.nodes,
      edges: s.edges,
      frames: p.takeFrames(),
      renders: p.takeRenders(),
    };
  });

  // Phase 2: turn the camera with the pointer for 4 s.
  const box = await scene.boundingBox();
  const cx = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  // Away from the nodes, so the drag turns the camera and does not move a node.
  await page.mouse.move(cx, (box?.y ?? 0) + 6);
  await page.mouse.down();
  const until = Date.now() + 4000;
  for (let i = 0; Date.now() < until; i++) {
    await page.mouse.move(
      cx + Math.sin(i / 20) * 300,
      (box?.y ?? 0) + 6 + Math.abs(Math.cos(i / 20)) * 200,
    );
  }
  await page.mouse.up();
  const orbit = await page.evaluate(() => {
    const p = (window as unknown as { __graph3d: Probe }).__graph3d;
    return {
      frames: p.takeFrames(),
      renders: p.takeRenders(),
      drawCalls: p.drawCalls(),
      triangles: p.triangles(),
      lod: p.lod(),
    };
  });
  const fps = (frames: number[]): number =>
    frames.length ? +((frames.length * 1000) / frames.reduce((a, b) => a + b, 0)).toFixed(1) : 0;
  const out = {
    requestedNodes: N,
    gl: GL,
    kinds: KINDS,
    forced: LOD,
    lod: orbit.lod,
    nodes: during.nodes,
    edges: during.edges,
    startupMs,
    layoutWallMs,
    layoutWorkerMs: Math.round(during.layoutMs),
    layoutPosts: during.posts,
    layoutFps: fps(during.frames),
    frameDuringLayoutMs: summary(during.frames),
    orbitFps: fps(orbit.frames),
    frameDuringOrbitMs: summary(orbit.frames),
    // CPU time of a render call, mediana and p95 (ms): what the page spends handing a frame over.
    renderCpuDuringLayoutMs: summary(during.renders),
    renderCpuDuringOrbitMs: summary(orbit.renders),
    drawCalls: orbit.drawCalls,
    triangles: orbit.triangles,
  };
  process.stdout.write('GRAPH3D_BENCH ' + JSON.stringify(out) + '\n');
  expect(orbit.frames.length).toBeGreaterThan(10);
});
