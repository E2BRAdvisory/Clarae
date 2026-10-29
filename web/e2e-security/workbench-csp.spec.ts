import { expect, test } from '@playwright/test';

// The vault workbench as the cloud binary delivers it: the production handler, its Content-Security-Policy
// and the gzip-compressed WebAssembly, with the minified bundle. A folder of this browser is opened
// without a cloud (`?local`, E2E builds only), so nothing but the page, the core and the browser's own
// storage is involved. Port 18096 is started by playwright.security.config.ts.
const ORIGIN = 'http://127.0.0.1:18096';

test('the workbench boots under the production policy, with no violation and no foreign request', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const violations: string[] = [];
  const foreign: string[] = [];
  const pageErrors: string[] = [];
  const wasm: { url: string; encoding: string | undefined; type: string | undefined }[] = [];
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
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp.replace('wasm-unsafe-eval', '')).not.toContain('unsafe-eval');
  expect(csp).toContain("worker-src 'self'");
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
  expect(violations).toEqual([]);
  expect(foreign).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the console page keeps the strict policy next to it', async ({ page }) => {
  const response = await page.goto(`${ORIGIN}/vaults`);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).not.toContain('unsafe-inline');
});
