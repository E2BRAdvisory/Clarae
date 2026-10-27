// Render benchmark of the graph view in real Chromium (headless). Skipped unless
// MEMOBRAIN_GRAPH_BENCH is set (a node count), so normal e2e runs are not slowed down:
//
//   MEMOBRAIN_GRAPH_BENCH=10000 yarn workspace @memobrain/desktop-frontend exec playwright test e2e/graph-bench.spec.ts
//
// The synthetic graph comes from the Wails mock (window.__MEMOBRAIN_GRAPH_FIXTURE__); the
// layout runs in the real Web Worker. See docs/qa/m6-graph-benchmark.md.
import { expect, test } from '@playwright/test';

const N = Number(process.env['MEMOBRAIN_GRAPH_BENCH'] ?? 0);

test.skip(!N, 'set MEMOBRAIN_GRAPH_BENCH=<nodes> to run the graph benchmark');

interface Stats {
  frames: number[];
  layoutMs: number;
  nodes: number;
  edges: number;
  ticks: number;
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

test(`graph of ${N} nodes: draw cost and frame rate`, async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript((n) => {
    const w = window as unknown as Record<string, unknown>;
    w['__MEMOBRAIN_GRAPH_FIXTURE__'] = n;
    w['__graphStats'] = { frames: [], layoutMs: 0, nodes: 0, edges: 0, ticks: 0 };
  }, N);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(page.getByTestId('graph-canvas')).toBeVisible();

  // Phase 1: while the worker lays the graph out (the renderer repaints on every update).
  const t0 = Date.now();
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as { __graphStats: Stats }).__graphStats.layoutMs),
      {
        timeout: 120_000,
      },
    )
    .toBeGreaterThan(0);
  const layoutWall = Date.now() - t0;
  const during = await page.evaluate(() => {
    const s = (window as unknown as { __graphStats: Stats }).__graphStats;
    return { frames: [...s.frames], layoutMs: s.layoutMs, ticks: s.ticks };
  });

  // Phase 2: pan and zoom continuously for 4 s; count real animation frames.
  await page.evaluate(() => {
    (window as unknown as { __graphStats: Stats }).__graphStats.frames.length = 0;
  });
  const fps = await page.evaluate(
    () =>
      new Promise<{ fps: number; intervals: number[] }>((resolve) => {
        const c = document.querySelector('canvas[data-testid="graph-canvas"]') as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const intervals: number[] = [];
        let last = performance.now();
        const start = last;
        let i = 0;
        const tick = (now: number): void => {
          intervals.push(now - last);
          last = now;
          i++;
          // Alternate wheel zoom around the centre and small drags.
          c.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: i % 40 < 20 ? -30 : 30,
              clientX: cx,
              clientY: cy,
              bubbles: true,
            }),
          );
          if (now - start < 4000) requestAnimationFrame(tick);
          else resolve({ fps: (intervals.length * 1000) / (now - start), intervals });
        };
        requestAnimationFrame(tick);
      }),
  );
  const interaction = await page.evaluate(() => {
    const s = (window as unknown as { __graphStats: Stats }).__graphStats;
    return { frames: [...s.frames], nodes: s.nodes, edges: s.edges };
  });
  const out = {
    requestedNodes: N,
    layoutWallMs: layoutWall,
    layoutWorkerMs: Math.round(during.layoutMs),
    layoutPosts: during.ticks,
    drawDuringLayoutMs: summary(during.frames),
    drawInteractionMs: summary(interaction.frames),
    interactionFps: +fps.fps.toFixed(1),
    rafIntervalMs: summary(fps.intervals),
    drawnNodes: interaction.nodes,
    drawnEdges: interaction.edges,
  };
  process.stdout.write('GRAPH_BENCH ' + JSON.stringify(out) + '\n');
  expect(interaction.frames.length).toBeGreaterThan(10);
});
