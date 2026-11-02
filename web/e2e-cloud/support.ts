import { expect, type BrowserContext, type Page } from '@playwright/test';

// Helpers of the specs that run the vault workbench against a real cloud (see playwright.cloud.config.ts).

type Bindings = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

/** Calls a Go binding from the page, as the UI does. */
export const bind = <T>(
  page: Page,
  service: string,
  method: string,
  ...args: unknown[]
): Promise<T> =>
  page.evaluate(
    async ({ service, method, args }) => {
      const app = (window as unknown as { go: { app: Bindings } }).go.app;
      return await app[service]![method]!(...args);
    },
    { service, method, args },
  ) as Promise<T>;

/** Signs in through Keycloak's own page, as a user would. */
export async function signIn(context: BrowserContext, user: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/vaults');
  await page.locator('#username').fill(user);
  await page.locator('#password').fill('memobrain-dev-password');
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'My vaults' })).toBeVisible({ timeout: 60_000 });
  return page;
}

/** The access token oidc-client-ts keeps in sessionStorage. */
export const accessToken = (page: Page): Promise<string> =>
  page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) ?? '';
      if (k.startsWith('oidc.user:'))
        return (JSON.parse(sessionStorage.getItem(k) ?? '{}') as { access_token: string })
          .access_token;
    }
    throw new Error('no OIDC session');
  });

export async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken(page);
  return page.evaluate(
    async ({ method, path, body, token }) => {
      const res = await fetch(`/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return (res.status === 204 ? null : await res.json()) as unknown;
    },
    { method, path, body, token },
  ) as Promise<T>;
}

/**
 * The OPFS folder of the signed-in account's vault copies (`accounts/<key>/fs/vaults`, see
 * web/src/workbench/storage.ts), as a path of folder names. The test signs one account in per
 * browser context, so there is a single account folder.
 */
export const VAULTS_PATH = async (page: Page): Promise<string[]> => {
  const account = await page.evaluate(async () => {
    const names: string[] = [];
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('accounts');
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys())
        names.push(name);
    } catch {
      /* no account folder yet */
    }
    return names;
  });
  if (account.length > 1) throw new Error(`more than one account folder: ${account.join(', ')}`);
  return ['accounts', account[0] ?? 'none', 'fs', 'vaults'];
};

/** The localStorage key of the signed-in account's vault markers (web/src/workbench/markers.ts). */
export const markersKey = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const prefix = 'memobrain.workbench.vaults@';
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
    if (keys.length > 1) throw new Error(`more than one account's markers: ${keys.join(', ')}`);
    // Before the workbench wrote any: the key does not exist, and reads as empty.
    return keys[0] ?? `${prefix}none`;
  });
