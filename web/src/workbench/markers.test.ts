import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKERS_KEY,
  adoptLegacyMarkers,
  clearLegacyMarkers,
  clearMarkers,
  markersKey,
  readLegacyMarkers,
  readMarkers,
  removeMarker,
  sweepPrivateCopies,
  unsynced,
  unsyncedVaults,
  updateMarker,
} from './markers';

/** Storage keys of two accounts (storage.ts accountKey). */
const A = 'a-alice';
const B = 'a-bob';

beforeEach(() => localStorage.clear());

describe('vault markers', () => {
  it('creates a marker with clean defaults and merges later updates', () => {
    updateMarker(A, 'v1', { name: 'Notes', kind: 'private', localPath: '/vaults/v1' }, 10);
    updateMarker(A, 'v1', { pending: 2 }, 20);
    expect(readMarkers(A)['v1']).toEqual({
      name: 'Notes',
      kind: 'private',
      localPath: '/vaults/v1',
      pending: 2,
      conflicts: 0,
      dirty: false,
      updatedAt: 20,
    });
  });

  it('removes one marker, and the storage key with the last one', () => {
    updateMarker(A, 'a', { kind: 'shared' });
    updateMarker(A, 'b', { kind: 'private' });
    removeMarker(A, 'a');
    expect(Object.keys(readMarkers(A))).toEqual(['b']);
    removeMarker(A, 'b');
    expect(localStorage.getItem(markersKey(A))).toBeNull();
    updateMarker(A, 'c', {});
    clearMarkers(A);
    expect(readMarkers(A)).toEqual({});
  });

  it('ignores a damaged entry instead of failing', () => {
    localStorage.setItem(markersKey(A), '{not json');
    expect(readMarkers(A)).toEqual({});
    localStorage.setItem(markersKey(A), '[1,2]');
    expect(readMarkers(A)).toEqual({});
  });

  it('says which copies hold something the cloud does not have', () => {
    updateMarker(A, 'clean', { name: 'Clean', kind: 'shared' });
    updateMarker(A, 'pending', { name: 'P', kind: 'private', pending: 3 });
    updateMarker(A, 'conflict', { name: 'C', kind: 'shared', conflicts: 1 });
    updateMarker(A, 'dirty', { name: 'D', kind: 'private', dirty: true });
    expect(unsynced(readMarkers(A)['clean']!)).toBe(false);
    expect(unsyncedVaults(A).map((v) => v.id)).toEqual(['pending', 'conflict', 'dirty']);
  });
});

describe('sweepPrivateCopies', () => {
  it('removes the clean private copies and keeps the rest', async () => {
    updateMarker(A, 'p-clean', { kind: 'private', localPath: '/vaults/p-clean' });
    updateMarker(A, 'p-pending', { kind: 'private', localPath: '/vaults/p-pending', pending: 1 });
    updateMarker(A, 'p-dirty', { kind: 'private', localPath: '/vaults/p-dirty', dirty: true });
    updateMarker(A, 's-clean', { kind: 'shared', localPath: '/vaults/s-clean' });
    const wipe = vi.fn(() => Promise.resolve());
    expect(await sweepPrivateCopies(A, wipe)).toEqual(['p-clean']);
    expect(wipe).toHaveBeenCalledExactlyOnceWith('/vaults/p-clean');
    expect(Object.keys(readMarkers(A)).sort()).toEqual(['p-dirty', 'p-pending', 's-clean']);
  });

  it('keeps the marker of a copy it could not remove (the next start tries again)', async () => {
    updateMarker(A, 'p', { kind: 'private', localPath: '/vaults/p' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await sweepPrivateCopies(A, () => Promise.reject(new Error('busy')))).toEqual([]);
    expect(readMarkers(A)['p']).toBeDefined();
  });
});

describe('markers of several accounts', () => {
  const marker = (name: string, pending = 0) => ({
    name,
    kind: 'private',
    localPath: `/vaults/${name}`,
    pending,
    conflicts: 0,
    dirty: false,
    updatedAt: 1,
  });

  it('keeps each account to its own markers', async () => {
    updateMarker(A, 'v1', { name: 'Alice', kind: 'private', localPath: '/vaults/v1', pending: 1 });
    updateMarker(B, 'v2', { name: 'Bob', kind: 'private', localPath: '/vaults/v2', pending: 2 });
    expect(Object.keys(readMarkers(A))).toEqual(['v1']);
    expect(unsyncedVaults(B).map((v) => v.name)).toEqual(['Bob']);
    // Bob's sweep never touches Alice's copies, nor does clearing his markers.
    const wipe = vi.fn(() => Promise.resolve());
    await sweepPrivateCopies(B, wipe);
    clearMarkers(B);
    expect(readMarkers(A)['v1']?.pending).toBe(1);
    expect(wipe).not.toHaveBeenCalledWith('/vaults/v1');
  });

  it("never reads the markers of an earlier version as an account's own", () => {
    localStorage.setItem(MARKERS_KEY, JSON.stringify({ old: marker('old', 3) }));
    expect(readMarkers(A)).toEqual({});
    expect(unsyncedVaults(A)).toEqual([]);
    expect(Object.keys(readLegacyMarkers())).toEqual(['old']);
  });

  it('gives the markers of an earlier version to the account that adopted the copies', () => {
    localStorage.setItem(MARKERS_KEY, JSON.stringify({ old: marker('old', 3) }));
    updateMarker(A, 'mine', { kind: 'shared' });
    adoptLegacyMarkers(A);
    expect(Object.keys(readMarkers(A)).sort()).toEqual(['mine', 'old']);
    expect(localStorage.getItem(MARKERS_KEY)).toBeNull();
    localStorage.setItem(MARKERS_KEY, JSON.stringify({ x: marker('x') }));
    clearLegacyMarkers();
    expect(readLegacyMarkers()).toEqual({});
  });
});
