import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIndexedDb } from '../test/fakeIndexedDb';
import type * as DeviceNs from './device';
import { LEGACY_DEVICE_DB } from './legacyNames';

// The registration of the browser as a device lives in IndexedDB. 1.4 kept it in a database under the
// product's former name: the first access of 2.0 copies it to the current one and deletes the old.

const SERVER = 'https://notes.example';
const NEW_DB = 'clarae-device';

type DeviceModule = typeof DeviceNs;
let idb: FakeIndexedDb;
let D: DeviceModule;

beforeEach(async () => {
  idb = installFakeIndexedDb();
  vi.resetModules(); // the migration is remembered per page: each test is a fresh page
  D = await import('./device');
});
afterEach(() => idb.restore());

const row = (account: string, deviceId: string, userId = 'u-' + account) => ({
  server: SERVER,
  account,
  deviceId,
  userId,
  savedAt: '2026-01-01T00:00:00Z',
});

/** The database 1.4 left: version 2, a registration per [server, account] and the 1.3 one per server. */
function profile14() {
  idb.seed(LEGACY_DEVICE_DB, 2, {
    devices: {
      keyPath: ['server', 'account'],
      rows: [row('alice', 'dev-alice'), row('bob', 'dev-bob')],
    },
    legacy: {
      keyPath: 'server',
      rows: [{ server: SERVER, deviceId: 'dev-old', userId: 'u-carol', savedAt: 'x' }],
    },
  });
}

describe('the device registration of a profile created by 1.4', () => {
  it('is found on the first read, and moved to the current database', async () => {
    profile14();
    expect(await D.loadDevice(SERVER, 'alice')).toEqual({
      deviceId: 'dev-alice',
      userId: 'u-alice',
    });
    expect(idb.databases.has(LEGACY_DEVICE_DB)).toBe(false);
    expect(idb.rows(NEW_DB, 'devices')).toHaveLength(2);
    expect(await D.loadDevice(SERVER, 'bob')).toEqual({ deviceId: 'dev-bob', userId: 'u-bob' });
    // the registration of 1.3 (by server) follows, to be taken over by its account as before
    expect(await D.legacyDeviceUser(SERVER)).toBe('u-carol');
  });

  it('marks this browser as the device in the console', async () => {
    profile14();
    expect(await D.thisBrowserDevice('u-alice', 'alice', SERVER)).toBe('dev-alice');
    expect(await D.thisBrowserDevice('u-bob', 'alice', SERVER)).toBeNull();
  });

  it('can be forgotten afterwards, and is not brought back from the old database', async () => {
    profile14();
    await D.forgetThisBrowserDevice('alice', 'u-alice', SERVER);
    // Only the registration of 1.3 (offered to any account, the core checks the user) is left.
    expect(await D.loadDevice(SERVER, 'alice')).toEqual({ deviceId: 'dev-old', userId: 'u-carol' });
    expect(await D.thisBrowserDevice('u-alice', 'alice', SERVER)).toBeNull();
    expect(idb.databases.has(LEGACY_DEVICE_DB)).toBe(false);
  });

  it('does not overwrite a registration the current database already has', async () => {
    profile14();
    idb.seed(NEW_DB, 2, {
      devices: { keyPath: ['server', 'account'], rows: [row('alice', 'dev-alice-2')] },
      legacy: { keyPath: 'server', rows: [] },
    });
    expect((await D.loadDevice(SERVER, 'alice'))?.deviceId).toBe('dev-alice-2');
    expect((await D.loadDevice(SERVER, 'bob'))?.deviceId).toBe('dev-bob');
  });

  it('is repeatable: an interruption between the copy and the deletion is finished next time', async () => {
    profile14();
    await D.loadDevice(SERVER, 'alice'); // copied and deleted
    // the page was closed after the copy, before the deletion: both databases are there
    profile14();
    vi.resetModules();
    D = await import('./device');
    expect((await D.loadDevice(SERVER, 'bob'))?.deviceId).toBe('dev-bob');
    expect(idb.databases.has(LEGACY_DEVICE_DB)).toBe(false);
    expect(idb.rows(NEW_DB, 'devices')).toHaveLength(2);
  });

  it('reads the database 1.2 kept (one row per server) as the 1.3 registration', async () => {
    idb.seed(LEGACY_DEVICE_DB, 1, {
      devices: {
        keyPath: 'server',
        rows: [{ server: SERVER, deviceId: 'dev-v1', userId: 'u-dave', savedAt: 'x' }],
      },
    });
    expect(await D.legacyDeviceUser(SERVER)).toBe('u-dave');
    expect(idb.databases.has(LEGACY_DEVICE_DB)).toBe(false);
  });
});

describe('a profile without the old database', () => {
  for (const listed of [true, false]) {
    it(`never creates it (${listed ? 'databases() available' : 'checked by opening it'})`, async () => {
      if (!listed) idb.withoutDatabasesList();
      expect(await D.loadDevice(SERVER, 'alice')).toBeNull();
      await D.saveDevice(SERVER, 'dev-1', 'u-alice', 'alice');
      expect(await D.loadDevice(SERVER, 'alice')).toEqual({ deviceId: 'dev-1', userId: 'u-alice' });
      expect(idb.databases.has(LEGACY_DEVICE_DB)).toBe(false);
      expect([...idb.databases.keys()]).toEqual([NEW_DB]);
    });
  }

  it('finds an old database by opening it where databases() does not exist', async () => {
    idb.withoutDatabasesList();
    profile14();
    expect((await D.loadDevice(SERVER, 'alice'))?.deviceId).toBe('dev-alice');
    expect(idb.databases.has(LEGACY_DEVICE_DB)).toBe(false);
  });
});
