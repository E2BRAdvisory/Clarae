import * as esbuild from 'esbuild';
import { expect, test } from '@playwright/test';

// The browser's device registration (web/src/workbench/device.ts) lives in IndexedDB, outside the
// OPFS folders that signing out and "forget this browser" wipe: the module is bundled and run in a
// page of the app's origin, where the worker of the core and the console share the same database.
const bundle = esbuild.buildSync({
  entryPoints: ['src/workbench/device.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Device',
  write: false,
  target: 'es2022',
}).outputFiles[0]!.text;

interface Stored {
  deviceId: string;
  userId: string;
}

interface DeviceModule {
  loadDevice(server: string, account: string): Promise<Stored | null>;
  saveDevice(server: string, deviceId: string, userId: string, account: string): Promise<void>;
  thisBrowserDevice(userId: string, account: string): Promise<string | null>;
  forgetThisBrowserDevice(account: string): Promise<void>;
  legacyDeviceUser(server: string): Promise<string | null>;
}

test.describe('browser device registration (P6)', () => {
  test.beforeEach(async ({ page }) => {
    // A static file of the app's origin (no app script that could touch the database meanwhile).
    await page.goto('/icon.svg');
    await page.evaluate((src) => void (0, eval)(src), bundle);
  });

  test('is remembered per server and account, survives an OPFS wipe and can be forgotten', async ({
    page,
  }) => {
    const r = await page.evaluate(async () => {
      const D = (globalThis as unknown as { Device: DeviceModule }).Device;
      const server = location.origin;
      const before = await D.loadDevice(server, 'sub-a');
      await D.saveDevice(server, 'dev-1', 'user-a', 'sub-a');
      // Another account of the same browser keeps a device of its own: no new one at every switch.
      await D.saveDevice(server, 'dev-2', 'user-b', 'sub-b');
      await D.saveDevice('https://other.example', 'dev-9', 'user-a', 'sub-a');
      // What "forget this browser" removes: the accounts' folders in OPFS.
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle('accounts', { create: true });
      await root.removeEntry('accounts', { recursive: true });
      const after = await D.loadDevice(server, 'sub-a');
      const mine = await D.thisBrowserDevice('user-a', 'sub-a');
      const bob = await D.thisBrowserDevice('user-b', 'sub-b');
      const someoneElse = await D.thisBrowserDevice('user-b', 'sub-a');
      await D.forgetThisBrowserDevice('sub-a');
      return {
        before,
        after,
        mine,
        bob,
        someoneElse,
        forgotten: await D.loadDevice(server, 'sub-a'),
        bobAfter: await D.loadDevice(server, 'sub-b'),
        other: await D.loadDevice('https://other.example', 'sub-a'),
      };
    });
    expect(r).toEqual({
      before: null,
      after: { deviceId: 'dev-1', userId: 'user-a' },
      mine: 'dev-1',
      bob: 'dev-2',
      someoneElse: null,
      forgotten: null,
      bobAfter: { deviceId: 'dev-2', userId: 'user-b' },
      other: { deviceId: 'dev-9', userId: 'user-a' },
    });
  });

  test('keeps the registration of an earlier version until its own user takes it over', async ({
    page,
  }) => {
    const r = await page.evaluate(async () => {
      // The database as versions up to 1.3 left it: one row per server.
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('memobrain-device', 1);
        req.onupgradeneeded = () =>
          req.result.createObjectStore('devices', { keyPath: 'server' }).put({
            server: location.origin,
            deviceId: 'dev-old',
            userId: 'user-a',
            savedAt: '2026-01-01T00:00:00Z',
          });
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error ?? new Error('open'));
      });
      const D = (globalThis as unknown as { Device: DeviceModule }).Device;
      const server = location.origin;
      // Offered to any account (the core keeps it only for user-a), marked only for user-a.
      const offered = await D.loadDevice(server, 'sub-b');
      const markedForA = await D.thisBrowserDevice('user-a', 'sub-a');
      const markedForB = await D.thisBrowserDevice('user-b', 'sub-b');
      // Bob registers his own: the old registration stays for user-a.
      await D.saveDevice(server, 'dev-b', 'user-b', 'sub-b');
      const legacyAfterB = await D.legacyDeviceUser(server);
      // user-a signs in and keeps the old device: it becomes the account's own.
      await D.saveDevice(server, 'dev-old', 'user-a', 'sub-a');
      return {
        offered,
        markedForA,
        markedForB,
        legacyAfterB,
        legacyAfterA: await D.legacyDeviceUser(server),
        a: await D.loadDevice(server, 'sub-a'),
        b: await D.loadDevice(server, 'sub-b'),
      };
    });
    expect(r).toEqual({
      offered: { deviceId: 'dev-old', userId: 'user-a' },
      markedForA: 'dev-old',
      markedForB: null,
      legacyAfterB: 'user-a',
      legacyAfterA: null,
      a: { deviceId: 'dev-old', userId: 'user-a' },
      b: { deviceId: 'dev-b', userId: 'user-b' },
    });
  });
});
