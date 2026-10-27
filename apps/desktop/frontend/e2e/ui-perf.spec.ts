// UI timing harness (M7-WP1) in real Chromium, headless, against the Wails mock:
//  - file explorer with a large vault tree (default 10 000 notes, all folders expanded;
//    tree_dom_nodes is the number of mounted rows),
//  - typing latency in a ~1 MB note (Appendix A: "digitazione senza lag su note <= 1 MB").
// Skipped unless NODUS_UI_BENCH is set, so normal e2e runs are not slowed down:
//
//   NODUS_UI_BENCH=1 yarn workspace @nodus/desktop-frontend exec playwright test e2e/ui-perf.spec.ts
//
// Numbers are for headless Chromium on the machine that runs them (software raster,
// no GPU, mock instead of the Go backend); the real webview needs a manual check.
// Options: NODUS_UI_BENCH_NOTES (tree size), NODUS_UI_BENCH_NOTE_KB (note size, default 1000),
// NODUS_UI_BENCH_OUT (write the numbers as JSON).
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const ON = !!process.env['NODUS_UI_BENCH'];
const NOTES = Number(process.env['NODUS_UI_BENCH_NOTES'] ?? 10000);
const NOTE_KB = Number(process.env['NODUS_UI_BENCH_NOTE_KB'] ?? 1000);

test.skip(!ON, 'set NODUS_UI_BENCH=1 to run the UI performance harness');
test.describe.configure({ mode: 'serial' });

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    emit(name: string, payload: unknown): void;
  };
}

const results: Record<string, number> = {};
const q = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return +(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(2);
};

async function openVault(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
}

test.afterAll(() => {
  console.log('UI perf:', JSON.stringify(results));
  const out = process.env['NODUS_UI_BENCH_OUT'];
  if (out) writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
});

test(`file explorer with ${NOTES} notes`, async ({ page }) => {
  test.setTimeout(180_000);
  await openVault(page);
  const t0 = Date.now();
  await page.evaluate((n) => {
    const w = window as unknown as MockWindow;
    const v = [...w.__mock.vaults.values()][0];
    if (!v) throw new Error('vault not open');
    const folders = Math.max(5, Math.floor(Math.sqrt(n) / 4));
    const paths: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = `area-${String(i % folders).padStart(2, '0')}/sub-${String(Math.floor(i / folders) % 12).padStart(2, '0')}/note ${i}.md`;
      v.files.set(p, `# note ${i}\n`);
      paths.push(p);
    }
    (window as unknown as { __treeT0: number }).__treeT0 = performance.now();
    w.__mock.emit('vault:file-changed', { vaultId: v.info.id, paths });
  }, NOTES);
  await expect(page.locator('.tree .node.file').first()).toBeVisible({ timeout: 120_000 });
  // The tree is complete when the scrollable list is as tall as its rows (rows may be windowed).
  await page.waitForFunction(
    (n) => (document.querySelector('.tree')?.scrollHeight ?? 0) > n * 20,
    NOTES,
    { timeout: 120_000 },
  );
  const render = await page.evaluate(
    () => performance.now() - (window as unknown as { __treeT0: number }).__treeT0,
  );
  const nodes = await page.locator('.tree .node').count();
  results['tree_render_ms'] = +render.toFixed(0);
  results['tree_dom_nodes'] = nodes;
  results['tree_wall_ms'] = Date.now() - t0;

  // Interaction cost: collapse and expand one folder, scroll the list.
  const toggle = await page.evaluate(async () => {
    const first = document.querySelector<HTMLElement>('.tree .node.folder');
    if (!first) return -1;
    const s = performance.now();
    first.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - s;
  });
  results['tree_toggle_ms'] = +toggle.toFixed(1);
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('.tree');
    if (!el) return [] as number[];
    const frames: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 60; i++) {
      el.scrollTop += 400;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    return frames;
  });
  results['tree_scroll_frame_p95_ms'] = q(scroll, 0.95);
  expect(nodes).toBeGreaterThan(0);
});

test(`typing latency in a ${NOTE_KB} KB note`, async ({ page }) => {
  test.setTimeout(180_000);
  await openVault(page);
  const path = 'Big.md';
  await page.evaluate(
    ({ p, kb }) => {
      const w = window as unknown as MockWindow;
      const v = [...w.__mock.vaults.values()][0];
      if (!v) throw new Error('vault not open');
      const para =
        'Lorem **ipsum** dolor sit amet, [[Link target]] consectetur #tag adipiscing elit, `code` sed do eiusmod tempor.\n';
      let text = '---\nstatus: draft\n---\n# Big note\n\n';
      let i = 0;
      while (text.length < kb * 1000) {
        if (i % 40 === 0) text += `\n## Section ${i / 40}\n\n`;
        text += para + (i % 5 === 4 ? '\n' : '');
        i++;
      }
      v.files.set(p, text);
      w.__mock.emit('vault:file-changed', { vaultId: v.info.id, paths: [p] });
    },
    { p: path, kb: NOTE_KB },
  );
  const open0 = Date.now();
  await page.locator('.tree .node', { hasText: 'Big' }).first().click();
  const editor = page.getByLabel('Note editor');
  await expect(editor).toBeVisible({ timeout: 60_000 });
  results['note_open_ui_ms'] = Date.now() - open0;
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');

  await page.evaluate(() => {
    const lat: number[] = [];
    (window as unknown as { __lat: number[] }).__lat = lat;
    document.addEventListener(
      'keydown',
      () => {
        const t0 = performance.now();
        // two frames: the update, then the paint that follows it
        requestAnimationFrame(() => requestAnimationFrame(() => lat.push(performance.now() - t0)));
      },
      true,
    );
  });
  await page.keyboard.type('the quick brown fox jumps over the lazy dog 0123456789', { delay: 40 });
  await page.waitForTimeout(300);
  const lat = await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat);
  results['typing_samples'] = lat.length;
  results['typing_latency_median_ms'] = q(lat, 0.5);
  results['typing_latency_p95_ms'] = q(lat, 0.95);
  results['typing_latency_max_ms'] = q(lat, 1);
  expect(lat.length).toBeGreaterThan(10);
});
