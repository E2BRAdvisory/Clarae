import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, bind, signIn } from '../e2e-cloud/support';
import { Device } from './device';

// Mixed clients against one cloud (P7 of the W8 review): device A is the desktop core, headless
// (apps/desktop/cmd/e2e-device: the same bindings, sync engine and vault folders as the desktop
// app); device B is the web workbench in Chromium (the same core compiled to WebAssembly, on
// OPFS). Run with scripts/e2e-mixed.sh (`task e2e-mixed`), which starts a throwaway stack.

const PASSPHRASE = 'correct horse battery staple 42';

test.describe.configure({ mode: 'serial' });

interface Opened {
  page: Page;
  id: string;
}

/** Opens a cloud vault (or an accepted share) in the web workbench and returns its local id. */
async function openOnWeb(page: Page, url: string): Promise<string> {
  await page.goto(url);
  await expect(page.locator('header.titlebar .title')).not.toBeEmpty({ timeout: 120_000 });
  const open = await bind<{ id: string; path: string }[]>(page, 'VaultAPI', 'ListOpen');
  expect(open.length).toBeGreaterThan(0);
  return open[0]!.id;
}

const webRead = async (page: Page, id: string, path: string): Promise<string> => {
  try {
    return (await bind<{ content: string }>(page, 'VaultAPI', 'ReadNote', id, path)).content;
  } catch {
    return '';
  }
};

const webFiles = async (page: Page, id: string): Promise<string[]> =>
  (await bind<{ path: string; isDir: boolean }[]>(page, 'VaultAPI', 'ListTree', id))
    .filter((e) => !e.isDir)
    .map((e) => e.path)
    .sort();

/** Polls the web workbench, asking it to sync before each read. */
async function webEventually<T>(
  o: Opened,
  read: () => Promise<T>,
  check: (v: T) => boolean,
  message: string,
): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        await bind(o.page, 'SyncAPI', 'SyncNow', o.id).catch(() => undefined);
        last = await read();
        return check(last);
      },
      { timeout: 120_000, intervals: [1000, 2000, 3000], message },
    )
    .toBe(true);
  return last as T;
}

/** Polls device A, asking it to sync before each read. */
async function deviceEventually<T>(
  d: Device,
  id: string,
  read: () => Promise<T>,
  check: (v: T) => boolean,
  message: string,
): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        await d.call('SyncAPI', 'SyncNow', id).catch(() => undefined);
        last = await read();
        return check(last);
      },
      { timeout: 120_000, intervals: [1000, 2000, 3000], message },
    )
    .toBe(true);
  return last as T;
}

/** Creates a cloud vault from device A, as "connect to the cloud" does on the desktop. */
async function vaultFromDevice(
  a: Device,
  name: string,
  kind: 'shared' | 'private',
  files: Record<string, string>,
): Promise<{ localId: string; cloudId: string; recoveryKey: string }> {
  const v = await a.openFolder(name);
  for (const [p, c] of Object.entries(files)) await a.call('VaultAPI', 'WriteNote', v.id, p, c, '');
  const linked = await a.call<{ cloudVaultId: string; recoveryKey: string }>(
    'SyncAPI',
    'LinkNew',
    v.id,
    name,
    kind,
    kind === 'private' ? PASSPHRASE : '',
  );
  await a.settle(v.id);
  return { localId: v.id, cloudId: linked.cloudVaultId, recoveryKey: linked.recoveryKey };
}

async function webPage(browser: Browser, user: string): Promise<Page> {
  return signIn(await browser.newContext(), user);
}

let a: Device;

test.beforeAll(async () => {
  a = await Device.start('user1', 'deviceA');
});

test.afterAll(async () => {
  await a?.stop();
});

test('a desktop and a browser merge concurrent edits of the same note', async ({ browser }) => {
  const name = `mixed-md-${Date.now()}`;
  const v = await vaultFromDevice(a, name, 'shared', {
    'Shared.md': 'line one\n\nline two\n\nline three\n',
  });
  const page = await webPage(browser, 'user1');
  const b: Opened = { page, id: await openOnWeb(page, `/vaults/${v.cloudId}/open`) };
  await webEventually(
    b,
    () => webRead(page, b.id, 'Shared.md'),
    (t) => t.includes('line two'),
    'B receives the note of A',
  );

  // Both edit different lines while paused, then reconnect: the client-side 3-way merge keeps both.
  await a.call('SyncAPI', 'SetPaused', v.localId, true);
  await bind(page, 'SyncAPI', 'SetPaused', b.id, true);
  const baseA = await a.call<{ hash: string; content: string }>(
    'VaultAPI',
    'ReadNote',
    v.localId,
    'Shared.md',
  );
  const baseB = await bind<{ hash: string; content: string }>(
    page,
    'VaultAPI',
    'ReadNote',
    b.id,
    'Shared.md',
  );
  await a.call(
    'VaultAPI',
    'WriteNote',
    v.localId,
    'Shared.md',
    baseA.content.replace('line one', 'LINE ONE from the desktop'),
    baseA.hash,
  );
  await bind(
    page,
    'VaultAPI',
    'WriteNote',
    b.id,
    'Shared.md',
    baseB.content.replace('line three', 'LINE THREE from the web'),
    baseB.hash,
  );
  await a.call('SyncAPI', 'SetPaused', v.localId, false);
  await a.settle(v.localId);
  await bind(page, 'SyncAPI', 'SetPaused', b.id, false);

  const merged = /LINE ONE from the desktop[\s\S]*line two[\s\S]*LINE THREE from the web/;
  await webEventually(
    b,
    () => webRead(page, b.id, 'Shared.md'),
    (t) => merged.test(t),
    'B holds the merge',
  );
  await deviceEventually(
    a,
    v.localId,
    () => a.read(v.localId, 'Shared.md'),
    (t) => merged.test(t),
    'A holds the merge',
  );
  // A note merged cleanly leaves no conflict copy on either side.
  expect((await a.files(v.localId)).filter((p) => p.includes('conflitto'))).toEqual([]);
  await page.context().close();
});

test('a canvas edited on both sides keeps both versions; a drawing merges by element', async ({
  browser,
}) => {
  const name = `mixed-json-${Date.now()}`;
  const canvas = (text: string) =>
    JSON.stringify({
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, text }],
      edges: [],
    });
  const shape = (id: string, x: number) => ({
    id,
    type: 'rectangle',
    x,
    y: 0,
    width: 80,
    height: 60,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: `a${id}`,
  });
  const drawing = (elements: unknown[]) =>
    JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'clarae',
      elements,
      appState: {},
      files: {},
    });
  const v = await vaultFromDevice(a, name, 'shared', {
    'Board.canvas': canvas('base'),
    'Sketch.excalidraw': drawing([shape('base', 0)]),
  });
  const page = await webPage(browser, 'user1');
  const b: Opened = { page, id: await openOnWeb(page, `/vaults/${v.cloudId}/open`) };
  await webEventually(
    b,
    () => webFiles(page, b.id),
    (f) => f.includes('Board.canvas') && f.includes('Sketch.excalidraw'),
    'B receives the canvas and the drawing',
  );

  await a.call('SyncAPI', 'SetPaused', v.localId, true);
  await bind(page, 'SyncAPI', 'SetPaused', b.id, true);
  // The same card changed on both sides (D-04: only Markdown merges line by line; a canvas card
  // changed twice is decided by server time and the loser becomes a conflict copy).
  await a.write(v.localId, 'Board.canvas', canvas('from the desktop'));
  const cb = await bind<{ hash: string }>(page, 'VaultAPI', 'ReadNote', b.id, 'Board.canvas');
  await bind(page, 'VaultAPI', 'WriteNote', b.id, 'Board.canvas', canvas('from the web'), cb.hash);
  // Different elements of the drawing added on each side (same author: merged by element id).
  await a.write(v.localId, 'Sketch.excalidraw', drawing([shape('base', 0), shape('desk', 200)]));
  const sb = await bind<{ hash: string }>(page, 'VaultAPI', 'ReadNote', b.id, 'Sketch.excalidraw');
  await bind(
    page,
    'VaultAPI',
    'WriteNote',
    b.id,
    'Sketch.excalidraw',
    drawing([shape('base', 0), shape('web', 400)]),
    sb.hash,
  );

  await a.call('SyncAPI', 'SetPaused', v.localId, false);
  await a.settle(v.localId);
  await bind(page, 'SyncAPI', 'SetPaused', b.id, false);

  // Both texts survive: one in Board.canvas, the other in a "(conflitto …)" copy, on both devices.
  const bothTexts = async (files: string[], read: (p: string) => Promise<string>) => {
    const texts = await Promise.all(files.filter((p) => p.endsWith('.canvas')).map(read));
    return (
      texts.some((t) => t.includes('from the desktop')) &&
      texts.some((t) => t.includes('from the web'))
    );
  };
  const webCanvas = await webEventually(
    b,
    () => webFiles(page, b.id),
    (f) => f.some((p) => /^Board \(conflitto .*\)\.canvas$/.test(p)),
    'B gets the conflict copy',
  );
  expect(await bothTexts(webCanvas, (p) => webRead(page, b.id, p))).toBe(true);
  const deskCanvas = await deviceEventually(
    a,
    v.localId,
    () => a.files(v.localId),
    (f) => f.some((p) => /^Board \(conflitto .*\)\.canvas$/.test(p)),
    'A gets the conflict copy',
  );
  expect(await bothTexts(deskCanvas, (p) => a.read(v.localId, p))).toBe(true);

  const ids = (raw: string) =>
    (
      JSON.parse(raw || '{"elements":[]}') as { elements: { id: string; isDeleted?: boolean }[] }
    ).elements
      .filter((e) => !e.isDeleted)
      .map((e) => e.id)
      .sort();
  await webEventually(
    b,
    async () => ids(await webRead(page, b.id, 'Sketch.excalidraw')),
    (x) => x.join() === 'base,desk,web',
    'B merges the drawing',
  );
  await deviceEventually(
    a,
    v.localId,
    async () => ids(await a.read(v.localId, 'Sketch.excalidraw')),
    (x) => x.join() === 'base,desk,web',
    'A merges the drawing',
  );
  await page.context().close();
});

test('a private vault created on the desktop is unlocked and synced in the browser', async ({
  browser,
}) => {
  const name = `mixed-private-${Date.now()}`;
  const v = await vaultFromDevice(a, name, 'private', {
    'Secret.md': '# Secret\n\nonly for my eyes\n',
  });
  expect(v.recoveryKey).not.toBe('');
  const page = await webPage(browser, 'user1');
  // The server holds opaque paths and content (D-02): the tree does not show the name.
  const tree = await api<{ items: { path: string }[] }>(page, 'GET', `/vaults/${v.cloudId}/tree`);
  expect(tree.items.length).toBeGreaterThan(0);
  expect(tree.items.map((e) => e.path)).not.toContain('Secret.md');

  await page.goto(`/vaults/${v.cloudId}/open`);
  const dialog = page.getByRole('dialog', { name: 'Unlock encrypted vault' });
  await dialog.getByRole('textbox', { name: 'Passphrase' }).fill(PASSPHRASE, { timeout: 120_000 });
  await dialog.getByRole('button', { name: 'Unlock' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  const b: Opened = {
    page,
    id: (await bind<{ id: string }[]>(page, 'VaultAPI', 'ListOpen'))[0]!.id,
  };
  await webEventually(
    b,
    () => webRead(page, b.id, 'Secret.md'),
    (t) => t.includes('only for my eyes'),
    'B decrypts the note of A',
  );

  // And back: a note written in the browser reaches the desktop, decrypted.
  await bind(page, 'VaultAPI', 'WriteNote', b.id, 'Reply.md', 'written in the browser\n', '');
  await webEventually(
    b,
    async () => (await bind<{ pending: number }>(page, 'SyncAPI', 'Status', b.id)).pending,
    (n) => n === 0,
    'B uploads',
  );
  await deviceEventually(
    a,
    v.localId,
    () => a.read(v.localId, 'Reply.md'),
    (t) => t.includes('written in the browser'),
    'A receives the note of B',
  );
  await page.context().close();
});

test('a share made on the desktop is accepted, mounted and revoked in the browser', async ({
  browser,
}) => {
  const name = `mixed-share-${Date.now()}`;
  const v = await vaultFromDevice(a, name, 'shared', {
    'Plan.md': '# Plan\n\nshared with user2\n',
  });
  const page = await webPage(browser, 'user2');
  const me = await api<{ id: string }>(page, 'GET', '/me');

  const share = await a.call<{ id: string }>(
    'SharingAPI',
    'CreateShare',
    v.localId,
    '',
    true,
    `${name} share`,
    [{ principalType: 'user', principalId: me.id, permission: 'editor' }],
    '',
  );
  // user2 sees the invitation in the console and accepts it.
  await expect
    .poll(
      async () =>
        (
          await api<{ items: { id: string }[] }>(page, 'GET', '/shares?scope=received&limit=500')
        ).items.map((s) => s.id),
      { timeout: 30_000 },
    )
    .toContain(share.id);
  await api(page, 'POST', `/shares/${share.id}:accept`);

  const b: Opened = {
    page,
    id: await openOnWeb(
      page,
      `/vaults/${encodeURIComponent(v.cloudId)}/open?share=${encodeURIComponent(share.id)}`,
    ),
  };
  await webEventually(
    b,
    () => webRead(page, b.id, 'Plan.md'),
    (t) => t.includes('shared with user2'),
    'the mount shows the file of A',
  );

  // An editor writes through the mount; the owner's desktop receives it.
  await bind(page, 'VaultAPI', 'WriteNote', b.id, 'From user2.md', 'hello from the browser\n', '');
  await deviceEventually(
    a,
    v.localId,
    () => a.read(v.localId, 'From user2.md'),
    (t) => t.includes('hello from the browser'),
    'A receives the note written in the mount',
  );

  // The owner revokes the share from the desktop: the vault is no longer reachable for user2.
  await a.call('SharingAPI', 'RevokeShare', share.id);
  await expect
    .poll(
      async () =>
        api(page, 'GET', `/vaults/${v.cloudId}/tree`).then(
          () => 'reachable',
          (e: Error) => e.message,
        ),
      { timeout: 30_000 },
    )
    .toMatch(/40[34]/);
  // What the browser writes afterwards never reaches the owner.
  await bind(page, 'VaultAPI', 'WriteNote', b.id, 'After revoke.md', 'too late\n', '').catch(
    () => undefined,
  );
  await bind(page, 'SyncAPI', 'SyncNow', b.id).catch(() => undefined);
  await a.settle(v.localId);
  await page.waitForTimeout(3000);
  await a.settle(v.localId);
  expect(await a.files(v.localId)).not.toContain('After revoke.md');
  await page.context().close();
});

test('the Config Profile switches the web workbench off; the desktop keeps syncing', async ({
  browser,
}) => {
  const name = `mixed-flag-${Date.now()}`;
  const v = await vaultFromDevice(a, name, 'shared', { 'Note.md': 'before\n' });
  const admin = await webPage(browser, 'admin');
  const profile = await api<{ id: string }>(admin, 'POST', '/admin/config-profiles', {
    name: `no web workbench ${Date.now()}`,
    is_global: true,
    config: { features: { web_workbench: false } },
  });
  try {
    const page = await webPage(browser, 'user1');
    // The console hides "Open in the browser", and a typed address is refused too.
    await expect(page.getByRole('heading', { name: 'My vaults' })).toBeVisible();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: `Open ${name} in the browser` })).toHaveCount(0);
    await page.goto(`/vaults/${v.cloudId}/open`);
    await expect(
      page.getByText('Your administrator has turned off opening vaults in the browser.'),
    ).toBeVisible({ timeout: 120_000 });

    // The desktop receives the same configuration, ignores the flag and keeps syncing.
    await a.call('ConfigAPI', 'Refresh').catch(() => undefined);
    await expect
      .poll(
        async () =>
          (await a.call<{ features: Record<string, boolean> }>('ConfigAPI', 'Effective')).features[
            'web_workbench'
          ],
        { timeout: 30_000 },
      )
      .toBe(false);
    await a.call('VaultAPI', 'WriteNote', v.localId, 'After.md', 'still syncing\n', '');
    await deviceEventually(
      a,
      v.localId,
      async () =>
        (
          await api<{ items: { path: string }[] }>(page, 'GET', `/vaults/${v.cloudId}/tree`)
        ).items.map((e) => e.path),
      (paths) => paths.includes('After.md'),
      'the note written on the desktop reaches the cloud',
    );
    await page.context().close();
  } finally {
    await api(admin, 'DELETE', `/admin/config-profiles/${profile.id}`);
    await admin.context().close();
  }
});

// Last: device A ends registered under a new id.
test('a device revoked from the browser stops, keeps its changes and registers again', async ({
  browser,
}) => {
  const name = `mixed-revoke-${Date.now()}`;
  const v = await vaultFromDevice(a, name, 'shared', {
    'Kept.md': 'uploaded before the revocation\n',
  });
  const page = await webPage(browser, 'user1');
  const before = await a.call<{ deviceId: string }>('AuthAPI', 'Status');
  const devices = async (): Promise<{ id: string; revoked_at?: string | null }[]> =>
    (await api<{ items: { id: string; revoked_at?: string | null }[] }>(page, 'GET', '/me/devices'))
      .items;
  expect((await devices()).map((d) => d.id)).toContain(before.deviceId);

  await api(page, 'DELETE', `/me/devices/${before.deviceId}`);
  await a.call('VaultAPI', 'WriteNote', v.localId, 'Late.md', 'written after the revocation\n', '');
  // The cloud refuses the commit (device revoked): A stops syncing and says why, with the file
  // still pending, instead of a generic sync error under a "ready" session.
  const status = await deviceEventually(
    a,
    v.localId,
    async () => ({
      sync: await a.call<{ phase: string; error: string; pending: number }>(
        'SyncAPI',
        'Status',
        v.localId,
      ),
      auth: await a.call<{ status: string; error: string; deviceId: string }>('AuthAPI', 'Status'),
    }),
    (s) => s.auth.status === 'device_revoked',
    'A notices the revocation',
  );
  test
    .info()
    .annotations.push({ type: 'device A after revocation', description: JSON.stringify(status) });
  expect(status.auth.deviceId).toBe(before.deviceId);
  expect(status.auth.error).toMatch(/revoked/);
  expect(status.sync.phase).toBe('offline');
  expect(status.sync.error).toMatch(/revoked/);
  expect(status.sync.pending).toBeGreaterThan(0);
  // The UI was told (auth:state), SyncNow is refused with the reason, nothing was lost.
  const events = await a.events();
  expect(
    events.some(
      (e) =>
        e.name === 'auth:state' && (e.payload as { status?: string }).status === 'device_revoked',
    ),
  ).toBe(true);
  await expect(a.call('SyncAPI', 'SyncNow', v.localId)).rejects.toThrow(/revoked/);
  expect(await a.read(v.localId, 'Late.md')).toBe('written after the revocation\n');
  const tree = async (): Promise<string[]> =>
    (await api<{ items: { path: string }[] }>(page, 'GET', `/vaults/${v.cloudId}/tree`)).items.map(
      (e) => e.path,
    );
  expect(await tree()).toContain('Kept.md');
  expect(await tree()).not.toContain('Late.md');

  // "Register this device again": a new device of the same account, and the pending file goes out.
  const after = await a.call<{ status: string; deviceId: string }>('AuthAPI', 'ReregisterDevice');
  expect(after.status).toBe('ready');
  expect(after.deviceId).not.toBe(before.deviceId);
  const listed = await devices();
  expect(listed.map((d) => d.id)).toContain(after.deviceId);
  expect(listed.map((d) => d.id)).not.toContain(before.deviceId);
  await a.settle(v.localId);
  await expect
    .poll(tree, { timeout: 60_000, message: 'Late.md reaches the cloud' })
    .toContain('Late.md');
  await page.context().close();
});
