import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeOpfs, type FakeDir } from '../test/fakeOpfs';
import { LEGACY_MARKERS_KEY } from './legacyNames';
import { readLegacyMarkers, readMarkers, updateMarker } from './markers';
import {
  LEGACY_OWNER_FILE,
  accountKey,
  adoptLegacyCopies,
  namespacedStorage,
  ownsLegacy,
  readLegacyOwner,
  removeAccountStorage,
  removeUnownedLegacy,
  storageOf,
  unownedLegacyPresent,
  type CloudView,
  type LegacyEvidence,
} from './storage';

const SERVER = 'https://notes.example';
const A = 'a-alice';
const B = 'a-bob';

const marker = (localPath: string, pending = 0) => ({
  name: localPath,
  kind: 'private',
  localPath,
  pending,
  conflicts: 0,
  dirty: false,
  updatedAt: 1,
});

describe('accountKey', () => {
  it('is stable, distinct per account and server, and a safe folder name', async () => {
    const a = await accountKey({ server: SERVER, subject: 'alice' });
    expect(a).toMatch(/^a[0-9a-f]{32}$/);
    expect(await accountKey({ server: SERVER, subject: 'alice' })).toBe(a);
    expect(await accountKey({ server: SERVER, subject: 'bob' })).not.toBe(a);
    expect(await accountKey({ server: 'https://other.example', subject: 'alice' })).not.toBe(a);
  });
});

describe('ownsLegacy', () => {
  const cloud: CloudView = {
    userId: 'u-alice',
    vaultIds: new Set(['v1', 'v2']),
    shareIds: new Set(['s1']),
  };
  const evidence = (over: Partial<LegacyEvidence> = {}): LegacyEvidence => ({
    session: { server_url: SERVER, profile: { userId: 'u-alice' } },
    vaultFolders: ['v1', 'new-x'],
    mountFolders: ['s1'],
    markers: { v2: marker('/vaults/new-x') },
    deviceUserId: 'u-alice',
    ...over,
  });

  it("holds when the session, the device and every copy are the account's", () => {
    expect(ownsLegacy(evidence(), SERVER, cloud)).toBe(true);
    expect(ownsLegacy(evidence({ deviceUserId: null }), SERVER, cloud)).toBe(true);
    // A creation that never reached the cloud left an empty folder: nobody's data.
    expect(
      ownsLegacy(
        evidence({ vaultFolders: ['new-y'], markers: { 'new-y': marker('/vaults/new-y') } }),
        SERVER,
        cloud,
      ),
    ).toBe(true);
  });

  it("fails as soon as anything may be someone else's", () => {
    for (const e of [
      evidence({ session: null }),
      evidence({
        session: { server_url: 'https://other.example', profile: { userId: 'u-alice' } },
      }),
      evidence({ session: { server_url: SERVER, profile: { userId: 'u-bob' } } }),
      evidence({ deviceUserId: 'u-bob' }),
      evidence({ vaultFolders: ['v-bob'] }),
      evidence({ vaultFolders: ['new-z'] }), // a folder no marker explains
      evidence({ markers: { 'v-bob': marker('/vaults/new-x') } }),
      evidence({ mountFolders: ['s-bob'] }),
    ])
      expect(ownsLegacy(e, SERVER, cloud)).toBe(false);
  });
});

describe('account storage in OPFS', () => {
  let root: FakeDir;
  let restore: () => void;
  beforeEach(() => {
    localStorage.clear();
    ({ root, restore } = installFakeOpfs());
  });
  afterEach(() => restore());

  /** The unnamed set of an earlier version, last used by `userId`. */
  async function legacy(userId: string, folders: string[] = ['v1']) {
    await root.write(
      'fs/memobrain/data/auth.json',
      JSON.stringify({ server_url: SERVER, profile: { userId } }),
    );
    for (const f of folders) await root.write(`fs/vaults/${f}/Note.md`, 'clear text');
    await root.mkdir('memobrain-sqlite/.opaque');
    localStorage.setItem(
      LEGACY_MARKERS_KEY,
      JSON.stringify(Object.fromEntries(folders.map((f) => [f, marker(`/vaults/${f}`, 1)]))),
    );
  }

  const adopt = (
    key: string,
    cloud: Partial<CloudView> & { userId: string },
    device: string | null = null,
  ) => {
    const ask = vi.fn(() =>
      Promise.resolve({ vaultIds: new Set<string>(), shareIds: new Set<string>(), ...cloud }),
    );
    return {
      ask,
      run: () =>
        adoptLegacyCopies({
          key,
          server: SERVER,
          deviceUserId: () => Promise.resolve(device),
          cloud: ask,
        }),
    };
  };

  it('gives each account folders of its own', async () => {
    expect(await storageOf(A)).toEqual(namespacedStorage(A));
    expect(namespacedStorage(A).fs).not.toBe(namespacedStorage(B).fs);
    expect(namespacedStorage(A).sqlite).not.toBe(namespacedStorage(B).sqlite);
  });

  it('lets the owner adopt the copies of an earlier version, as they are', async () => {
    await legacy('u-alice');
    const { run, ask } = adopt(A, { userId: 'u-alice', vaultIds: new Set(['v1']) });
    expect(await run()).toBe('owned');
    expect(ask).toHaveBeenCalledWith({ vaults: true, shares: false });
    expect(await readLegacyOwner()).toBe(A);
    expect(await storageOf(A)).toMatchObject({ fs: 'fs', legacy: true });
    // Nothing was moved or removed; the markers are Alice's now.
    expect(root.has('fs/vaults/v1/Note.md')).toBe(true);
    expect(Object.keys(readMarkers(A))).toEqual(['v1']);
    expect(readLegacyMarkers()).toEqual({});
    // Another account never gets them, and starts with its own folders.
    expect(await adopt(B, { userId: 'u-bob', vaultIds: new Set(['v1']) }).run()).toBe('other');
    expect(await storageOf(B)).toEqual(namespacedStorage(B));
  });

  it("leaves alone, unopened, copies it cannot show to be the account's", async () => {
    await legacy('u-alice', ['v1', 'v-bob']);
    // Bob signs in first: the session is Alice's.
    expect(await adopt(B, { userId: 'u-bob', vaultIds: new Set(['v1', 'v-bob']) }).run()).toBe(
      'unproven',
    );
    // Alice cannot reach one of the vaults: it may be someone else's.
    expect(await adopt(A, { userId: 'u-alice', vaultIds: new Set(['v1']) }).run()).toBe('unproven');
    // The device of the earlier version belongs to someone else.
    expect(
      await adopt(A, { userId: 'u-alice', vaultIds: new Set(['v1', 'v-bob']) }, 'u-bob').run(),
    ).toBe('unproven');
    expect(await readLegacyOwner()).toBeNull();
    expect(await storageOf(A)).toEqual(namespacedStorage(A));
    expect(Object.keys(readLegacyMarkers()).sort()).toEqual(['v-bob', 'v1']);
    expect(await unownedLegacyPresent()).toBe(true);
  });

  it('never merges the copies into an account that already has its own', async () => {
    await legacy('u-alice');
    await root.mkdir(`accounts/${A}/fs`);
    const { run, ask } = adopt(A, { userId: 'u-alice', vaultIds: new Set(['v1']) });
    expect(await run()).toBe('kept');
    expect(ask).not.toHaveBeenCalled();
  });

  it('does not ask the cloud without a session to compare, and fails when the cloud cannot answer', async () => {
    await root.write('fs/vaults/v1/Note.md', 'x');
    const none = adopt(A, { userId: 'u-alice' });
    expect(await none.run()).toBe('unproven');
    expect(none.ask).not.toHaveBeenCalled();

    await legacy('u-alice');
    await expect(
      adoptLegacyCopies({
        key: A,
        server: SERVER,
        deviceUserId: () => Promise.resolve(null),
        cloud: () => Promise.reject(new Error('offline')),
      }),
    ).rejects.toThrow('offline');
    expect(await readLegacyOwner()).toBeNull();
  });

  it('forgets the markers of an earlier version whose copies are gone', async () => {
    localStorage.setItem(LEGACY_MARKERS_KEY, JSON.stringify({ v1: marker('/vaults/v1') }));
    expect(await adopt(A, { userId: 'u-alice' }).run()).toBe('none');
    expect(localStorage.getItem(LEGACY_MARKERS_KEY)).toBeNull();
  });

  it('removes the storage of one account and nothing else', async () => {
    await root.write(`accounts/${A}/fs/vaults/v1/Note.md`, 'alice');
    await root.write(`accounts/${B}/fs/vaults/v2/Note.md`, 'bob');
    await legacy('u-carol');
    updateMarker(A, 'v1', { pending: 1 });
    updateMarker(B, 'v2', { pending: 1 });
    expect(await removeAccountStorage(A)).toEqual({ removed: true, busy: false });
    expect(root.has(`accounts/${A}`)).toBe(false);
    expect(root.has(`accounts/${B}/fs/vaults/v2/Note.md`)).toBe(true);
    expect(root.has('fs/vaults/v1/Note.md')).toBe(true);
    expect(readMarkers(A)).toEqual({});
    expect(Object.keys(readMarkers(B))).toEqual(['v2']);
  });

  it('removes the copies an account adopted, with the record of the adoption', async () => {
    await legacy('u-alice');
    await adopt(A, { userId: 'u-alice', vaultIds: new Set(['v1']) }).run();
    expect(await removeAccountStorage(A)).toEqual({ removed: true, busy: false });
    expect(root.names()).toEqual([]);
    expect(readMarkers(A)).toEqual({});
  });

  it('says busy and keeps the markers while a workbench tab holds the files', async () => {
    (await root.mkdir(`accounts/${A}/sqlite`)).hold();
    updateMarker(A, 'v1', { pending: 1 });
    expect(await removeAccountStorage(A)).toEqual({ removed: false, busy: true });
    expect(Object.keys(readMarkers(A))).toEqual(['v1']);
  });

  it('deletes the copies of an earlier version only while nobody adopted them', async () => {
    await legacy('u-alice');
    await root.write(LEGACY_OWNER_FILE, JSON.stringify({ account: A }));
    expect(await unownedLegacyPresent()).toBe(false);
    await removeUnownedLegacy();
    expect(root.has('fs/vaults/v1/Note.md')).toBe(true);

    await root.removeEntry(LEGACY_OWNER_FILE);
    expect(await unownedLegacyPresent()).toBe(true);
    expect(await removeUnownedLegacy()).toEqual({ removed: true, busy: false });
    expect(root.names()).toEqual([]);
    expect(localStorage.getItem(LEGACY_MARKERS_KEY)).toBeNull();
  });
});
