import { expect, test } from '@playwright/test';

// Runs against the production bundle delivered by the embedded-SPA handler.

test('the SPA loads with strict headers, SRI and no request to another origin', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL as string).origin;
  const requests: string[] = [];
  const violations: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (/content security policy|refused to/i.test(m.text())) violations.push(m.text());
  });

  // No API sits behind this server: answer the bootstrap document with a same-origin issuer.
  await page.route('**/api/v1/client-config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        issuer: `${origin}/realms/test`,
        web_client_id: 'clarae-web',
        audience: 'clarae-api',
      }),
    }),
  );
  await page.route('**/realms/**', (route) => {
    const issuer = `${origin}/realms/test`;
    if (route.request().url().endsWith('/.well-known/openid-configuration'))
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        }),
      });
    return route.fulfill({ contentType: 'text/html', body: '<h1>Identity provider</h1>' });
  });

  const response = await page.goto('/');
  expect(response).not.toBeNull();
  const h = response?.headers() ?? {};
  const csp = h['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp.replace('wasm-unsafe-eval', '')).not.toContain('unsafe-eval');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['permissions-policy']).toContain('camera=()');

  // Wait until the app rendered something (the sign-in redirect or the config error).
  await page.waitForLoadState('networkidle');

  // Every script/stylesheet carries integrity and there is no inline code.
  const html = await (await page.request.get('/')).text();
  const dom = await page.evaluate((src) => {
    const document = new DOMParser().parseFromString(src, 'text/html');
    return {
      scripts: Array.from(document.querySelectorAll('script')).map((s) => ({
        src: s.getAttribute('src'),
        integrity: s.getAttribute('integrity'),
        inline: !s.getAttribute('src') && (s.textContent ?? '').trim() !== '',
      })),
      links: Array.from(
        document.querySelectorAll('link[rel=stylesheet],link[rel=modulepreload]'),
      ).map((l) => l.getAttribute('integrity')),
      inlineStyles: document.querySelectorAll('style').length,
    };
  }, html);
  expect(dom.scripts.length).toBeGreaterThan(0);
  for (const s of dom.scripts) {
    expect(s.inline).toBe(false);
    expect(s.integrity ?? '').toMatch(/^sha384-/);
  }
  for (const i of dom.links) expect(i ?? '').toMatch(/^sha384-/);
  expect(dom.inlineStyles).toBe(0);

  // No network request left the origin.
  const foreign = requests.filter(
    (u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'),
  );
  expect(foreign).toEqual([]);
  expect(violations).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the browser enforces the policy: inline script and foreign fetches are blocked', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const blocked: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => blocked.push(e.violatedDirective));
    (window as unknown as { __pwned?: boolean }).__pwned = false;
    const s = document.createElement('script');
    s.textContent = 'window.__pwned = true';
    document.head.appendChild(s);
    let fetched = true;
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
    } catch {
      fetched = false;
    }
    await new Promise((r) => setTimeout(r, 50));
    return {
      pwned: (window as unknown as { __pwned?: boolean }).__pwned,
      fetched,
      blocked,
    };
  });
  expect(result.pwned).toBe(false);
  expect(result.fetched).toBe(false);
  expect(result.blocked.join(' ')).toContain('script-src');
  expect(result.blocked.join(' ')).toContain('connect-src');
});

test('unknown API paths and assets are never answered with HTML', async ({ request }) => {
  const api = await request.get('/api/v1/anything');
  expect(api.status()).toBe(404);
  expect(await api.text()).not.toContain('<html');
  const miss = await request.get('/assets/does-not-exist.js');
  expect(miss.status()).toBe(404);
  expect(miss.headers()['x-content-type-options']).toBe('nosniff');
});
