import type { Page } from '@playwright/test';
import {
  cloudVault,
  installCloudMock,
  ME,
  uuid,
  type CloudMock,
  type CloudSeed,
  type CloudShare,
  type CloudVault,
} from '../../../../web/e2e/cloudMock';
import { test as base, expect, onWeb } from './support';

/**
 * A cloud account for the specs of the cloud panels (ADR-0045 §4), on both targets of the e2e
 * matrix. The seed is written once, in the shapes of api/openapi.yaml:
 *  - `desktop`: the desktop UI on the Wails mock; the seed goes into the mock's cloud state
 *    (window.__mock.sync, window.__mock.sharing), after signing in from Settings › Cloud;
 *  - `web`: the workbench on the real Go core in the browser, signed in as the page's account; the
 *    seed is served by the REST mock of web/e2e/cloudMock.ts, which the core calls from its worker,
 *    and the open vault is one of the seeded cloud vaults (a page of the browser is a cloud vault).
 * The `cloud` fixture checks at the end of each test that the core kept to the REST contract.
 */

export { ME, uuid, cloudVault as vault, type CloudSeed, type CloudShare, type CloudVault };

export interface Cloud {
  /**
   * Opens a vault signed in to a cloud that holds `seed`. On the web the page opens the cloud vault
   * `open` (one of the seed's vaults); on the desktop a folder of the mock opens, linked to `open`
   * when `link` is set. `files` are notes of the open vault.
   */
  openVault(
    page: Page,
    seed: CloudSeed,
    opts: { open: string; link?: boolean; files?: Record<string, string> },
  ): Promise<void>;
  /** The REST mock (web) or null (desktop). */
  readonly rest: CloudMock | null;
  /** The shares the account owns or manages, as the cloud holds them now (both targets). */
  ownedShares(page: Page): Promise<CloudShare[]>;
}

interface MockWindow {
  __mock: {
    vaults: Map<string, { info: { id: string }; files: Map<string, string> }>;
    sync: {
      cloudVaults: Record<string, unknown>[];
      devices: Record<string, unknown>[];
      usage: Record<string, unknown>;
    };
    sharing: {
      invitations: Record<string, unknown>[];
      owned: CloudShare[];
      received: Record<string, unknown>[];
      users: Record<string, unknown>[];
      groups: Record<string, unknown>[];
      mountFiles: Map<string, Record<string, string>>;
    };
    emit(name: string, payload: unknown): void;
  };
  go: { app: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> };
}

/**
 * The seed in the state of the Wails mock. The bindings speak the API's types (ADR-0045 §6), so it
 * is the seed itself, sorted as the core lists it: the shares the user owns or manages, the
 * invitations and the answered ones; the owner of a share has no `my_permission`.
 */
function mockSeed(seed: CloudSeed) {
  const shares = (seed.shares ?? []).map((s) => {
    if (s.owner_id !== ME) return s;
    const own = { ...s };
    delete own.my_permission;
    return own;
  });
  const received = shares.filter((s) => s.owner_id !== ME && s.my_status);
  return {
    vaults: seed.vaults ?? [],
    devices: (seed.devices ?? []).map((d) => ({ ...d, current: false })),
    usage: seed.usage ?? null,
    users: seed.directory?.users ?? [],
    groups: seed.directory?.groups ?? [],
    owned: shares.filter(
      (s) => s.owner_id === ME || (s.my_permission === 'manager' && s.my_status === 'accepted'),
    ),
    invitations: received.filter((s) => s.my_status === 'pending'),
    received: received.filter((s) => s.my_status !== 'pending'),
    mountFiles: Object.entries(seed.files ?? {}).filter(([id]) => shares.some((s) => s.id === id)),
  };
}

async function openOnDesktop(
  page: Page,
  seed: CloudSeed,
  opts: { open: string; link?: boolean; files?: Record<string, string> },
): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open folder as vault' }).click();
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Cloud', exact: true }).click();
  await page.getByLabel('Server address').fill('https://memobrain.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
  await page.evaluate(
    async ({ s, open, link, files }) => {
      const w = window as unknown as MockWindow;
      w.__mock.sync.cloudVaults.push(...s.vaults);
      w.__mock.sync.devices.push(...s.devices);
      if (s.usage) w.__mock.sync.usage = s.usage;
      w.__mock.sharing.users.push(...s.users);
      w.__mock.sharing.groups.push(...s.groups);
      w.__mock.sharing.owned.push(...s.owned);
      w.__mock.sharing.invitations.push(...s.invitations);
      w.__mock.sharing.received.push(...s.received);
      for (const [id, f] of s.mountFiles) w.__mock.sharing.mountFiles.set(id, f);
      const v = [...w.__mock.vaults.values()][0]!;
      for (const [p, c] of Object.entries(files)) v.files.set(p, c);
      if (link) await w.go.app['SyncAPI']!['LinkExisting']!(v.info.id, open);
      if (s.invitations.length)
        w.__mock.emit('shares:changed', { shareId: s.invitations[0]!['id'], kind: 'granted' });
    },
    { s: mockSeed(seed), open: opts.open, link: Boolean(opts.link), files: opts.files ?? {} },
  );
  // Back to the workbench: the specs open the panel they test, which fetches the seeded state.
  await page.keyboard.press('Escape');
}

/** Opens the page of a cloud vault: the core signs in, links the vault and downloads its files. */
async function openOnWeb(
  page: Page,
  opts: { open: string; files?: Record<string, string> },
): Promise<void> {
  await page.goto(`/vaults/${opts.open}/open`);
  await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible({ timeout: 90_000 });
  // The seeded notes arrived through the sync (tree, changes, blobs of the mock).
  for (const name of Object.keys(opts.files ?? {}))
    await expect(page.locator('.tree .node', { hasText: name.replace(/\.md$/, '') })).toBeVisible();
}

/** `test` of support.ts with the `cloud` fixture. */
export const test = base.extend<{ cloud: Cloud }>({
  cloud: async ({ context }, provide) => {
    let rest: CloudMock | null = null;
    const cloud: Cloud = {
      get rest() {
        return rest;
      },
      async openVault(page, seed, opts) {
        if (!onWeb()) return openOnDesktop(page, seed, opts);
        const files = opts.files
          ? { ...seed.files, [opts.open]: { ...seed.files?.[opts.open], ...opts.files } }
          : seed.files;
        rest = await installCloudMock(context, { ...seed, ...(files ? { files } : {}) });
        // The page's account: the sign-in double of E2E builds (web/src/auth/e2e.ts).
        await context.addInitScript(() =>
          sessionStorage.setItem('memobrain.e2e.user', JSON.stringify({ name: 'Alice' })),
        );
        return openOnWeb(page, opts);
      },
      async ownedShares(page) {
        if (rest)
          return rest.state.shares.filter(
            (s) =>
              s.owner_id === ME || (s.my_permission === 'manager' && s.my_status === 'accepted'),
          );
        return page.evaluate(() => (window as unknown as MockWindow).__mock.sharing.owned);
      },
    };
    await provide(cloud);
    // Every request the core made was an operation of the contract, with valid bodies both ways.
    if (rest) expect((rest as CloudMock).problems).toEqual([]);
  },
});

export { expect };
