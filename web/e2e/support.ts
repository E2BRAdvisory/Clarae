import { type Page, type Route } from '@playwright/test';

export const ME = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';

export type Handler = (route: Route, body: unknown) => unknown;

/** Mocks /api/v1/** by "METHOD /path" (query string ignored). Anything else is a 404 problem. */
export async function mockApi(page: Page, routes: Record<string, unknown>) {
  const calls: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname.replace(/^\/api\/v1/, '')}`;
    calls.push(key);
    const entry = routes[key];
    if (entry === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          code: 'NOT_FOUND',
        }),
      });
      return;
    }
    const body = req.postData() ? (JSON.parse(req.postData() as string) as unknown) : undefined;
    const out = typeof entry === 'function' ? (entry as Handler)(route, body) : entry;
    if (out === undefined) await route.fulfill({ status: 204 });
    else
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(out),
      });
  });
  return calls;
}

export async function signedIn(page: Page, roles: string[] = []) {
  await page.addInitScript(
    (user) => {
      window.sessionStorage.setItem('memobrain.e2e.user', JSON.stringify(user));
    },
    { name: 'Alice', roles },
  );
}
