import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeOpfs, type FakeDir, type FakeOpfsOptions } from '../test/fakeOpfs';
import { legacyMarkersKey, migrateMarkers, readMarkers, updateMarker } from './markers';
import {
  DATA_DIR,
  LEGACY_DATA_DIR,
  LEGACY_OWNER_FILE,
  LEGACY_STORAGE,
  accountKeys,
  dataDirOf,
  migrateAccountStorage,
  namespacedStorage,
  readLegacyOwner,
  removeAccountStorage,
  storageOf,
} from './storage';

// A browser profile that was used with 1.4 and is opened by 2.0 for the first time: everything the
// account had under the old names must be there under the new ones, and nothing may be lost, however
// the migration is interrupted (D-04: no silent loss of changes not uploaded yet).

const SERVER = 'https://notes.example';
const ALICE = { server: SERVER, subject: 'alice' };

const marker = (localPath: string, pending = 0) => ({
  name: localPath,
  kind: 'private',
  localPath,
  pending,
  conflicts: 0,
  dirty: false,
  updatedAt: 1,
});

describe('a profile created by 1.4', () => {
  let root: FakeDir;
  let options: FakeOpfsOptions;
  let restore: () => void;
  beforeEach(() => {
    localStorage.clear();
    ({ root, options, restore } = installFakeOpfs());
  });
  afterEach(() => restore());

  /** What 1.4 left for Alice: her folder under the old key, with a copy that holds unsynced edits. */
  async function profile() {
    const { key, legacyKey } = await accountKeys(ALICE);
    const at = `accounts/${legacyKey}`;
    await root.write(`${at}/fs/memobrain/data/auth.json`, '{"session":"alice"}');
    await root.write(`${at}/fs/memobrain/data/mounts/s1/Shared.md`, 'shared copy');
    await root.write(`${at}/fs/vaults/v1/Note.md`, 'an edit the cloud has not seen');
    await root.write(`${at}/sqlite/.opaque-pool/0001`, 'sqlite pool file');
    localStorage.setItem(
      legacyMarkersKey(legacyKey),
      JSON.stringify({ v1: marker('/vaults/v1', 2) }),
    );
    return { key, legacyKey, at, next: `accounts/${key}` };
  }

  for (const native of [true, false]) {
    it(`takes it to the new names, nothing lost (${native ? 'folder moved' : 'folder copied'})`, async () => {
      options.move = native;
      const { key, legacyKey, next } = await profile();
      expect(await migrateAccountStorage(key, legacyKey)).toBe('moved');
      migrateMarkers(key, legacyKey);
      const s = await storageOf(key);
      expect(s).toEqual(namespacedStorage(key));

      // The account folder, the pool as it was (its contents are the core's), the vault copy.
      expect(root.has(`accounts/${legacyKey}`)).toBe(false);
      expect(root.read(`${next}/sqlite/.opaque-pool/0001`)).toBe('sqlite pool file');
      expect(root.read(`${next}/fs/vaults/v1/Note.md`)).toBe('an edit the cloud has not seen');
      // The core's data folder stays where 1.4 put it, with its mounts, and the core is started on
      // it: the databases of the pool are stored under paths that hold its name.
      expect(await dataDirOf(s)).toBe(LEGACY_DATA_DIR);
      expect(LEGACY_DATA_DIR).toBe('/memobrain/data');
      expect(root.read(`${next}/fs/memobrain/data/auth.json`)).toBe('{"session":"alice"}');
      expect(root.read(`${next}/fs/memobrain/data/mounts/s1/Shared.md`)).toBe('shared copy');
      expect(root.has(`${next}/fs/clarae`)).toBe(false);
      // The marker, and what it says (changes pending), follow.
      expect(readMarkers(key)['v1']?.pending).toBe(2);
      expect(localStorage.getItem(legacyMarkersKey(legacyKey))).toBeNull();
      expect(root.names()).toEqual(['accounts']);
      expect((await root.mkdir('accounts')).names()).toEqual([key]);
    });
  }

  it('resumes after an interruption in the middle of the move, with nothing duplicated', async () => {
    options.move = false;
    const { key, legacyKey, at, next } = await profile();
    options.writesLeft = 3;
    await expect(migrateAccountStorage(key, legacyKey)).rejects.toThrow();
    // The old folder is whole and still what the old name says; the new one is not complete.
    expect(root.read(`${at}/fs/vaults/v1/Note.md`)).toBe('an edit the cloud has not seen');
    expect(root.has(`accounts/${key}.migrated`)).toBe(false);

    options.writesLeft = null;
    expect(await migrateAccountStorage(key, legacyKey)).toBe('moved');
    expect(root.has(at)).toBe(false);
    expect(root.read(`${next}/fs/vaults/v1/Note.md`)).toBe('an edit the cloud has not seen');
    expect(root.read(`${next}/sqlite/.opaque-pool/0001`)).toBe('sqlite pool file');
  });

  it('starts the core of a profile without a data folder on the current name', async () => {
    const { key } = await accountKeys(ALICE);
    expect(await dataDirOf(namespacedStorage(key))).toBe(DATA_DIR);
    expect(DATA_DIR).toBe('/clarae/data');
    await root.write(`accounts/${key}/fs/clarae/data/auth.json`, '{}');
    expect(await dataDirOf(namespacedStorage(key))).toBe(DATA_DIR);
  });

  it('does nothing for an account the profile never had', async () => {
    const { key, legacyKey } = await accountKeys(ALICE);
    expect(await migrateAccountStorage(key, legacyKey)).toBe('none');
    expect(root.names()).toEqual([]);
  });

  it("leaves another account's folder alone", async () => {
    const bob = await accountKeys({ server: SERVER, subject: 'bob' });
    await root.write(`accounts/${bob.legacyKey}/fs/vaults/b1/Note.md`, "bob's");
    const { key, legacyKey } = await profile();
    await migrateAccountStorage(key, legacyKey);
    expect(root.read(`accounts/${bob.legacyKey}/fs/vaults/b1/Note.md`)).toBe("bob's");
    expect(root.has(`accounts/${bob.key}`)).toBe(false);
  });

  it('keeps the old folder when the account already has storage of its own under the new key', async () => {
    const { key, legacyKey, at, next } = await profile();
    await root.write(`${next}/fs/vaults/v9/Note.md`, 'created by 2.0');
    expect(await migrateAccountStorage(key, legacyKey)).toBe('kept');
    expect(root.has(`${at}/fs/vaults/v1/Note.md`)).toBe(true);
    expect(root.read(`${next}/fs/vaults/v9/Note.md`)).toBe('created by 2.0');
  });

  it('follows the record of an adopted 1.3 set to the new key, and keeps its data folder', async () => {
    const { key, legacyKey } = await accountKeys(ALICE);
    await root.write(
      'fs/memobrain/data/auth.json',
      JSON.stringify({ server_url: SERVER, profile: { userId: 'u-alice' } }),
    );
    await root.write('fs/vaults/v1/Note.md', 'clear text');
    await root.mkdir('memobrain-sqlite/.opaque');
    await root.write(LEGACY_OWNER_FILE, JSON.stringify({ account: legacyKey }));
    options.move = false;

    expect(await migrateAccountStorage(key, legacyKey)).toBe('none');
    expect(await readLegacyOwner()).toBe(key);
    const s = await storageOf(key);
    expect(s).toEqual(LEGACY_STORAGE); // still adopted: nothing is moved
    expect(await dataDirOf(s)).toBe(LEGACY_DATA_DIR);
    expect(root.has('fs/memobrain/data/auth.json')).toBe(true);
    expect(root.has('fs/clarae')).toBe(false);
    expect(root.has('fs/vaults/v1/Note.md')).toBe(true);
    expect(root.has('memobrain-sqlite/.opaque')).toBe(true);
  });

  it('removes what is left under the old names with the rest, when the account signs out', async () => {
    const { key, legacyKey, at } = await profile();
    const bob = await accountKeys({ server: SERVER, subject: 'bob' });
    await root.write(`accounts/${bob.key}/fs/vaults/b1/Note.md`, "bob's");
    updateMarker(key, 'v2', { pending: 1 });
    expect(await removeAccountStorage(key, legacyKey)).toEqual({ removed: true, busy: false });
    expect(root.has(at)).toBe(false);
    expect(root.has(`accounts/${key}`)).toBe(false);
    expect(readMarkers(key, legacyKey)).toEqual({});
    expect(localStorage.getItem(legacyMarkersKey(legacyKey))).toBeNull();
    expect(root.has(`accounts/${bob.key}/fs/vaults/b1/Note.md`)).toBe(true);
  });

  it('removes the markers of an interrupted move and the adopted set the old key owned', async () => {
    const { key, legacyKey } = await accountKeys(ALICE);
    await root.write(`accounts/${key}.migrating`, '');
    await root.write('fs/vaults/v1/Note.md', 'clear text');
    await root.write(LEGACY_OWNER_FILE, JSON.stringify({ account: legacyKey }));
    expect(await removeAccountStorage(key, legacyKey)).toEqual({ removed: true, busy: false });
    expect(root.names()).toEqual([]);
  });

  it('is busy, and removes nothing it should keep, while a 1.4 tab holds its folder', async () => {
    const { key, legacyKey, at } = await profile();
    (await root.mkdir(`${at}/sqlite`)).hold();
    updateMarker(key, 'v1', { pending: 1 });
    expect(await removeAccountStorage(key, legacyKey)).toEqual({ removed: false, busy: true });
    expect(root.has(`${at}/fs/vaults/v1/Note.md`)).toBe(true);
    expect(Object.keys(readMarkers(key, legacyKey))).toEqual(['v1']);
  });
});
