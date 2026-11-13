import * as esbuild from 'esbuild';
import { expect, test } from '@playwright/test';

// A browser profile used with 1.4 holds its data under the names of the former product. 2.0 takes it
// to the new names before the core starts (web/src/workbench/storage.ts, device.ts). The unit tests
// run on fakes; this one runs the same code against the real Origin Private File System and
// IndexedDB of Chromium: the folder move where the browser offers it, and the copy where it does not.
const build = (entry: string, globalName: string): string =>
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName,
    write: false,
    target: 'es2022',
  }).outputFiles[0]!.text;
const storageBundle = build('src/workbench/storage.ts', 'Storage');
const deviceBundle = build('src/workbench/device.ts', 'Device');

interface StorageModule {
  accountKeys(a: { server: string; subject: string }): Promise<{ key: string; legacyKey: string }>;
  migrateAccountStorage(key: string, legacyKey: string): Promise<string>;
  dataDirOf(s: { fs: string }): Promise<string>;
  namespacedStorage(key: string): { fs: string };
}
interface DeviceModule {
  loadDevice(server: string, account: string): Promise<{ deviceId: string; userId: string } | null>;
}
type Root = FileSystemDirectoryHandle;

test.describe('profile created by 1.4', () => {
  test.beforeEach(async ({ page }) => {
    // A static file of the app's origin: no app script touches the storage meanwhile.
    await page.goto('/icon.svg');
    await page.evaluate(async (src) => {
      (0, eval)(src);
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys())
        await root.removeEntry(name, { recursive: true });
    }, storageBundle);
  });

  for (const folderMove of [true, false]) {
    test(`moves the account to the new names, nothing lost (${folderMove ? 'folder move' : 'copy'})`, async ({
      page,
    }) => {
      const r = await page.evaluate(async (move) => {
        // Where the browser cannot move a folder (or the test wants the copy), take the method away.
        if (!move)
          (FileSystemDirectoryHandle.prototype as unknown as { move?: unknown }).move = undefined;
        const S = (globalThis as unknown as { Storage: StorageModule }).Storage;
        const { key, legacyKey } = await S.accountKeys({
          server: location.origin,
          subject: 'alice',
        });
        const root: Root = await navigator.storage.getDirectory();
        const put = async (path: string, text: string): Promise<void> => {
          const parts = path.split('/');
          let d = root;
          for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
          const f = await d.getFileHandle(parts[parts.length - 1]!, { create: true });
          const w = await f.createWritable();
          await w.write(text);
          await w.close();
        };
        const get = async (path: string): Promise<string | null> => {
          try {
            let d = root;
            const parts = path.split('/');
            for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
            const f = await d.getFileHandle(parts[parts.length - 1]!);
            return await (await f.getFile()).text();
          } catch {
            return null;
          }
        };
        await put(`accounts/${legacyKey}/fs/memobrain/data/auth.json`, '{"session":"alice"}');
        await put(`accounts/${legacyKey}/fs/vaults/v1/Note.md`, 'an edit the cloud has not seen');
        await put(`accounts/${legacyKey}/sqlite/.opaque-pool/0001`, 'x'.repeat(100_000));
        const moved = await S.migrateAccountStorage(key, legacyKey);
        const data = await S.dataDirOf(S.namespacedStorage(key));
        const names: string[] = [];
        const accounts = await root.getDirectoryHandle('accounts');
        for await (const n of (accounts as unknown as { keys(): AsyncIterable<string> }).keys())
          names.push(n);
        return {
          moved,
          data,
          names,
          key,
          note: await get(`accounts/${key}/fs/vaults/v1/Note.md`),
          auth: await get(`accounts/${key}/fs/memobrain/data/auth.json`),
          pool: (await get(`accounts/${key}/sqlite/.opaque-pool/0001`))?.length,
          oldGone: (await get(`accounts/${legacyKey}/fs/vaults/v1/Note.md`)) === null,
          newData: await get(`accounts/${key}/fs/clarae/data/auth.json`),
        };
      }, folderMove);
      expect(r).toMatchObject({
        moved: 'moved',
        data: '/memobrain/data', // the core's data folder stays: the pool's databases are keyed by it
        note: 'an edit the cloud has not seen',
        auth: '{"session":"alice"}',
        pool: 100_000,
        oldGone: true,
        newData: null,
      });
      expect(r.names).toEqual([r.key]); // no old folder, no marker files left behind
    });
  }

  test('copies the device registration of 1.4 to the current database and deletes the old one', async ({
    page,
  }) => {
    await page.evaluate((src) => void (0, eval)(src), deviceBundle);
    const r = await page.evaluate(async () => {
      const server = location.origin;
      // The database as 1.4 left it (version 2), under the former name.
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('memobrain-device', 2);
        req.onupgradeneeded = () => {
          req.result
            .createObjectStore('devices', { keyPath: ['server', 'account'] })
            .put({ server, account: 'sub-a', deviceId: 'dev-1', userId: 'user-a', savedAt: 'x' });
          req.result.createObjectStore('legacy', { keyPath: 'server' });
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error ?? new Error('open'));
      });
      const D = (globalThis as unknown as { Device: DeviceModule }).Device;
      const found = await D.loadDevice(server, 'sub-a');
      const names = (await indexedDB.databases()).map((d) => d.name);
      // Nothing to migrate the second time, and no old database is created by looking for it.
      await D.loadDevice(server, 'sub-a');
      return {
        found,
        names: names.sort(),
        after: (await indexedDB.databases()).map((d) => d.name),
      };
    });
    expect(r.found).toEqual({ deviceId: 'dev-1', userId: 'user-a' });
    expect(r.names).toContain('clarae-device');
    expect(r.names).not.toContain('memobrain-device');
    expect(r.after).not.toContain('memobrain-device');
  });
});
