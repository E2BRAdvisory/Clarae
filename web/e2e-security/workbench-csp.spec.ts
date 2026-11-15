import { expect, test } from '@playwright/test';

// The vault workbench as the cloud binary delivers it: the production handler, its Content-Security-Policy
// and the gzip-compressed WebAssembly, with the minified bundle. A folder of this browser is opened
// without a cloud (`?local`, E2E builds only), so nothing but the page, the core and the browser's own
// storage is involved. Port 18096 is started by playwright.security.config.ts.
const ORIGIN = 'http://127.0.0.1:18096';
// The chunk that loads the pdf.js worker (web/scripts/esbuild.mjs, verifiedLoaders).
const PDF_WORKER_CHUNK = '/pdf\\.worker\\.min-[^/]+\\.js$';

test('the workbench boots under the production policy, with no violation and no foreign request', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const violations: string[] = [];
  const foreign: string[] = [];
  const pageErrors: string[] = [];
  const wasm: { url: string; encoding: string | undefined; type: string | undefined }[] = [];
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  page.on('console', (m) => {
    if (/content security policy|refused to/i.test(m.text())) violations.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u);
  });
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm')) {
      const h = r.headers();
      wasm.push({ url: r.url(), encoding: h['content-encoding'], type: h['content-type'] });
    }
  });

  const response = await page.goto(`${ORIGIN}/vaults/csp/open?local`);
  const csp = response?.headers()['content-security-policy'] ?? '';
  // The workbench policy: inline styles (CodeMirror, Excalidraw), never inline or eval-ed script.
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  // Inline script only for the import map that pins the chunks, by its hash (never 'unsafe-inline').
  expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/]+=*';/);
  expect(csp.replace('wasm-unsafe-eval', '')).not.toContain('unsafe-eval');
  // blob: only for the workers, started from the bytes the page checked with SRI.
  expect(csp).toContain("worker-src 'self' blob:;");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response?.headers()['x-frame-options']).toBe('DENY');

  await expect(page.locator('header.titlebar .title')).toHaveText('csp', { timeout: 120_000 });

  // The real core answers, through the real fs shim, SQLite pool and worker, under that policy.
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
  await bind(
    'VaultAPI',
    'WriteNote',
    vault!.id,
    'Policy.md',
    '# Policy\n\nunder a strict header\n',
    '',
  );
  await expect
    .poll(
      async () =>
        (
          await bind<{ hits: unknown[] }>(
            'SearchAPI',
            'Query',
            vault!.id,
            'strict header',
            'all',
            5,
          )
        ).hits?.length,
      { timeout: 60_000 },
    )
    .toBe(1);

  // The cloud sent the WebAssembly compressed, as application/wasm, for both files.
  expect(wasm.length).toBeGreaterThanOrEqual(2);
  for (const w of wasm) {
    expect(w.type).toBe('application/wasm');
    expect(w.encoding).toBe('gzip');
  }
  // The core runs in a worker started from a blob: of its SRI-checked script, never from its URL.
  expect(workers.some((u) => u.startsWith('blob:'))).toBe(true);
  expect(workers.filter((u) => !u.startsWith('blob:'))).toEqual([]);

  // The pdf.js worker is fetched with its integrity and handed to pdf.js as a blob: of the checked bytes.
  const pdfWorker = await page.evaluate(async (pattern) => {
    const u = Object.keys(
      (
        JSON.parse(document.querySelector('script[type="importmap"]')?.textContent ?? '{}') as {
          integrity?: Record<string, string>;
        }
      ).integrity ?? {},
    ).find((k) => new RegExp(pattern).test(k));
    if (!u) return 'no pdf.worker chunk in the import map';
    return String(((await import(u)) as { default: unknown }).default);
  }, PDF_WORKER_CHUNK);
  expect(pdfWorker).toMatch(/^blob:/);

  // A lazy chunk is pinned by the import map too: altered bytes are refused, the original loads.
  const lazy = await page.evaluate(() => {
    const map = JSON.parse(
      document.querySelector('script[type="importmap"]')?.textContent ?? '{}',
    ) as {
      integrity?: Record<string, string>;
    };
    return Object.keys(map.integrity ?? {}).find((u) => /\/mermaid\.core-[^/]+\.js$/.test(u));
  });
  expect(lazy).toBeTruthy();
  await page.route(`${ORIGIN}${lazy}`, async (route) => {
    const original = await route.fetch();
    await route.fulfill({ response: original, body: (await original.text()) + '\n;0;' });
  });
  const tampered = await page.evaluate(
    (u) =>
      import(u).then(
        () => 'loaded',
        (e: unknown) => String(e),
      ),
    lazy!,
  );
  expect(tampered).not.toBe('loaded');
  violations.length = 0; // the refusal of the altered chunk is reported on the console by design
  expect(violations).toEqual([]);
  expect(foreign).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// The 3D graph (M18-D, ADR-0055) under the same policy: three.js and 3d-force-graph come as a lazy
// chunk, the layout runs in the layout worker, and nothing of it may need 'unsafe-eval' or a request
// outside the origin. WebGL2 in headless Chromium comes from SwiftShader (the flags are the file's:
// `use` cannot be given to one group of tests, and no other test here draws with WebGL).
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

  // The instanced level (solids, lit by their own shader program) under the same policy: the E2E
  // build draws the nodes at that level when asked, and the scene is started again at it.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)['__CLARAE_GRAPH3D_LOD__'] = 'instanced';
  });
  await page.getByTestId('graph-mode').click();
  await expect(page.getByTestId('graph-canvas')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('graph-mode').click();
  await expect(scene).toHaveAttribute('data-graph-lod', 'instanced', { timeout: 60_000 });
  await expect(scene).toHaveAttribute('data-graph-settled', '1', { timeout: 60_000 });
  const solids = await page.evaluate(() => {
    const p = (
      window as unknown as {
        __graph3d?: { solids(): { shape: string; nodes: number }[]; drawCalls(): number };
      }
    ).__graph3d;
    return p ? { solids: p.solids(), calls: p.drawCalls() } : null;
  });
  expect(solids?.solids.reduce((n, g) => n + g.nodes, 0)).toBeGreaterThanOrEqual(names.length);
  expect(solids?.calls).toBeGreaterThan(0);

  // Turn the view and walk to a node, so that the camera and the labels run under the policy too.
  await scene.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press(']');
  await expect(scene.locator('.graph3d-label.current')).toBeVisible();

  expect(violations).toEqual([]);
  expect(foreign).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('a tampered core worker script never runs', async ({ page }) => {
  test.setTimeout(120_000);
  // Same bytes plus one statement: what a compromised cache or CDN in front of the cloud could serve.
  await page.route(/\/assets\/core-worker-[^/]+\.js$/, async (route) => {
    const original = await route.fetch();
    await route.fulfill({ response: original, body: (await original.text()) + '\n;0;' });
  });
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await page.goto(`${ORIGIN}/vaults/tampered/open?local`);
  await expect(page.locator('body')).toContainText(/core-worker[^ ]*\.js/, { timeout: 60_000 });
  expect(workers).toEqual([]);
  await expect(page.locator('header.titlebar .title')).toHaveCount(0);
});

test('a tampered chunk never runs', async ({ page }) => {
  test.setTimeout(120_000);
  // Every chunk the entry imports is altered; the import map pins them, so the entry never evaluates.
  await page.route(/\/assets\/chunk-[^/]+\.js$/, async (route) => {
    const original = await route.fetch();
    await route.fulfill({ response: original, body: (await original.text()) + '\n;0;' });
  });
  const integrityErrors: string[] = [];
  page.on('console', (m) => {
    if (/integrity/i.test(m.text())) integrityErrors.push(m.text());
  });
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await page.goto(`${ORIGIN}/vaults/tampered-chunk/open?local`);
  await expect.poll(() => integrityErrors.length, { timeout: 30_000 }).toBeGreaterThan(0);
  // Nothing of the workbench ran: no status message, no worker, no UI.
  await expect(page.locator('#status')).toBeEmpty();
  expect(workers).toEqual([]);
  await expect(page.locator('header.titlebar .title')).toHaveCount(0);
});

test('an altered pdf.js worker is refused before it can start', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route(/\/assets\/pdf\.worker\.min-[^/]+\.mjs$/, async (route) => {
    const original = await route.fetch();
    await route.fulfill({ response: original, body: (await original.text()) + '\n;0;' });
  });
  await page.goto(`${ORIGIN}/vaults/tampered-pdf/open?local`);
  await expect(page.locator('header.titlebar .title')).toHaveText('tampered-pdf', {
    timeout: 120_000,
  });
  const result = await page.evaluate(async (pattern) => {
    const u = Object.keys(
      (
        JSON.parse(document.querySelector('script[type="importmap"]')?.textContent ?? '{}') as {
          integrity?: Record<string, string>;
        }
      ).integrity ?? {},
    ).find((k) => new RegExp(pattern).test(k));
    return import(u ?? '/missing.js').then(
      (m: { default: unknown }) => `loaded ${String(m.default)}`,
      (e: unknown) => String(e),
    );
  }, PDF_WORKER_CHUNK);
  // A failed SRI check rejects the fetch (Chromium says only "Failed to fetch").
  expect(result).toMatch(/failed to fetch|integrity/i);
});

test('the console page keeps the strict policy next to it', async ({ page }) => {
  const response = await page.goto(`${ORIGIN}/vaults`);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).not.toContain('unsafe-inline');
});
