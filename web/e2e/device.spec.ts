import * as esbuild from 'esbuild';
import { expect, test } from '@playwright/test';

// The browser's device registration (web/src/workbench/device.ts) lives in IndexedDB, outside the
// OPFS folder that signing out and "forget this browser" wipe: the module is bundled and run in a
// page of the app's origin, where the worker of the core and the console share the same database.
const bundle = esbuild.buildSync({
  entryPoints: ['src/workbench/device.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Device',
  write: false,
  target: 'es2022',
}).outputFiles[0]!.text;

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
      interface Stored {
        deviceId: string;
        userId: string;
      }
      const D = (
        globalThis as unknown as {
          Device: {
            loadDevice(server: string): Promise<Stored | null>;
            saveDevice(server: string, deviceId: string, userId: string): Promise<void>;
            thisBrowserDevice(userId: string): Promise<string | null>;
            forgetThisBrowserDevice(): Promise<void>;
          };
        }
      ).Device;
      const server = location.origin;
      const before = await D.loadDevice(server);
      await D.saveDevice(server, 'dev-1', 'user-a');
      await D.saveDevice('https://other.example', 'dev-9', 'user-a');
      // What "forget this browser" removes: the core's folders in OPFS.
      const root = await navigator.storage.getDirectory();
      await root.getDirectoryHandle('fs', { create: true });
      await root.removeEntry('fs', { recursive: true });
      const after = await D.loadDevice(server);
      const mine = await D.thisBrowserDevice('user-a');
      const someoneElse = await D.thisBrowserDevice('user-b');
      await D.forgetThisBrowserDevice();
      return {
        before,
        after,
        mine,
        someoneElse,
        forgotten: await D.loadDevice(server),
        other: await D.loadDevice('https://other.example'),
      };
    });
    expect(r).toEqual({
      before: null,
      after: { deviceId: 'dev-1', userId: 'user-a' },
      mine: 'dev-1',
      someoneElse: null,
      forgotten: null,
      other: { deviceId: 'dev-9', userId: 'user-a' },
    });
  });
});
