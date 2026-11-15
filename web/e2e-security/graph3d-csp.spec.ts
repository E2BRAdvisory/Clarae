import { expect, test } from '@playwright/test';

// The 3D graph under the production policy of the vault workbench (M18-D, ADR-0055): three.js and
// 3d-force-graph come as a lazy chunk, the layout runs in the layout worker, and nothing of it may
// need 'unsafe-eval' or a request outside the origin. Same server as workbench-csp.spec.ts (port
// 18096, minified E2E build, a folder of this browser opened with `?local`).
const ORIGIN = 'http://127.0.0.1:18096';

// WebGL2 in headless Chromium: SwiftShader.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('the 3D graph runs under the production CSP: no violation, no foreign request, no eval', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const violations: string[] = [];
  const foreign: string[] = [];
  const pageErrors: string[] = [];
  const scripts: string[] = [];
  page.on('console', (m) => {
    if (/content security policy|refused to|unsafe-eval/i.test(m.text())) violations.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u);
    if (/\/assets\/[^/]+\.js$/.test(u)) scripts.push(u.split('/').pop() ?? '');
  });

  const response = await page.goto(`${ORIGIN}/vaults/csp3d/open?local`);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/]+=*';/);
  expect(csp.replace('wasm-unsafe-eval', '')).not.toContain('unsafe-eval');
  await expect(page.locator('header.titlebar .title')).toHaveText('csp3d', { timeout: 120_000 });

  const bind = <T>(service: string, method: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(
      async ({ service, method, args }) => {
        const app = (
          window as unknown as {
            go: { app: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
          }
        ).go.app;
        return await app[service]![method]!(...args);
      },
      { service, method, args },
    ) as Promise<T>;
  const [vault] = await bind<{ id: string }[]>('VaultAPI', 'ListOpen');
  const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
  for (const [i, n] of names.entries()) {
    const links = names.filter((_, j) => j !== i && (j + i) % 2 === 1).map((x) => `[[${x}]]`);
    await bind('VaultAPI', 'WriteNote', vault!.id, `${n}.md`, `# ${n}\n\n${links.join(' ')}\n`, '');
  }
  await expect
    .poll(
      async () =>
        (await bind<{ hits: unknown[] }>('SearchAPI', 'Query', vault!.id, 'Gamma', 'all', 5)).hits
          ?.length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  // The graph in 2D first: three.js is not part of it.
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: 60_000 });
  expect(scripts.filter((s) => /^Graph3D-/.test(s))).toEqual([]);

  await page.getByTestId('graph-mode').click();
  const scene = page.getByTestId('graph-3d');
  await expect(scene).toBeVisible({ timeout: 60_000 });
  await expect(scene).toHaveAttribute('data-graph-mode', '3d');
  // three.js came as a lazy chunk, after the click.
  await expect.poll(() => scripts.some((s) => /^Graph3D-/.test(s))).toBe(true);
  // The layout in three dimensions ran in the worker, under the policy, to the end.
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 60_000 });

  // The scene drew, in a WebGL2 context that is still alive.
  const gl = await page.evaluate(() => {
    const p = (
      window as unknown as {
        __graph3d?: { nodes(): number; drawCalls(): number; contextLost(): boolean };
      }
    ).__graph3d;
    const canvas = document.querySelector('[data-testid="graph-3d"] canvas');
    return p
      ? { canvas: !!canvas, nodes: p.nodes(), calls: p.drawCalls(), lost: p.contextLost() }
      : null;
  });
  expect(gl).not.toBeNull();
  expect(gl?.canvas).toBe(true);
  expect(gl?.nodes).toBeGreaterThanOrEqual(names.length);
  expect(gl?.calls).toBeGreaterThan(0);
  expect(gl?.lost).toBe(false);

  // Turn the view and walk to a node, so that the camera and the labels run under the policy too.
  await scene.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press(']');
  await expect(scene.locator('.graph3d-label.current')).toBeVisible();

  expect(violations).toEqual([]);
  expect(foreign).toEqual([]);
  expect(pageErrors).toEqual([]);
});
