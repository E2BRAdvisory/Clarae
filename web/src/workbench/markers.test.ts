import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARKERS_KEY,
  clearMarkers,
  readMarkers,
  removeMarker,
  sweepPrivateCopies,
  unsynced,
  unsyncedVaults,
  updateMarker,
} from './markers';

beforeEach(() => localStorage.clear());

describe('vault markers', () => {
  it('creates a marker with clean defaults and merges later updates', () => {
    updateMarker('v1', { name: 'Notes', kind: 'private', localPath: '/vaults/v1' }, 10);
    updateMarker('v1', { pending: 2 }, 20);
    expect(readMarkers()['v1']).toEqual({
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
    updateMarker('a', { kind: 'shared' });
    updateMarker('b', { kind: 'private' });
    removeMarker('a');
    expect(Object.keys(readMarkers())).toEqual(['b']);
    removeMarker('b');
    expect(localStorage.getItem(MARKERS_KEY)).toBeNull();
    updateMarker('c', {});
    clearMarkers();
    expect(readMarkers()).toEqual({});
  });

  it('ignores a damaged entry instead of failing', () => {
    localStorage.setItem(MARKERS_KEY, '{not json');
    expect(readMarkers()).toEqual({});
    localStorage.setItem(MARKERS_KEY, '[1,2]');
    expect(readMarkers()).toEqual({});
  });

  it('says which copies hold something the cloud does not have', () => {
    updateMarker('clean', { name: 'Clean', kind: 'shared' });
    updateMarker('pending', { name: 'P', kind: 'private', pending: 3 });
    updateMarker('conflict', { name: 'C', kind: 'shared', conflicts: 1 });
    updateMarker('dirty', { name: 'D', kind: 'private', dirty: true });
    expect(unsynced(readMarkers()['clean']!)).toBe(false);
    expect(unsyncedVaults().map((v) => v.id)).toEqual(['pending', 'conflict', 'dirty']);
  });
});

describe('sweepPrivateCopies', () => {
  it('removes the clean private copies and keeps the rest', async () => {
    updateMarker('p-clean', { kind: 'private', localPath: '/vaults/p-clean' });
    updateMarker('p-pending', { kind: 'private', localPath: '/vaults/p-pending', pending: 1 });
    updateMarker('p-dirty', { kind: 'private', localPath: '/vaults/p-dirty', dirty: true });
    updateMarker('s-clean', { kind: 'shared', localPath: '/vaults/s-clean' });
    const wipe = vi.fn(() => Promise.resolve());
    expect(await sweepPrivateCopies(wipe)).toEqual(['p-clean']);
    expect(wipe).toHaveBeenCalledExactlyOnceWith('/vaults/p-clean');
    expect(Object.keys(readMarkers()).sort()).toEqual(['p-dirty', 'p-pending', 's-clean']);
  });

  it('keeps the marker of a copy it could not remove (the next start tries again)', async () => {
    updateMarker('p', { kind: 'private', localPath: '/vaults/p' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await sweepPrivateCopies(() => Promise.reject(new Error('busy')))).toEqual([]);
    expect(readMarkers()['p']).toBeDefined();
  });
});
