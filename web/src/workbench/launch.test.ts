import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreTimeoutError, type CoreHandle } from './bridge';
import { sweepWithin } from './launch';
import { readMarkers, updateMarker } from './markers';

beforeEach(() => localStorage.clear());

const privateCopy = (id: string) =>
  updateMarker('acct', id, { name: id, kind: 'private', localPath: `/vaults/${id}` });

describe('sweepWithin', () => {
  it('removes the clean private copies, each within the limit', async () => {
    privateCopy('a');
    privateCopy('b');
    const wipe = vi.fn((_path: string, _ms?: number) => Promise.resolve());
    const stuck = await sweepWithin('acct', { wipe } as unknown as CoreHandle, 5_000);
    expect(stuck).toBeNull();
    expect(wipe.mock.calls).toEqual([
      ['/vaults/a', 5_000],
      ['/vaults/b', 5_000],
    ]);
    expect(readMarkers('acct')).toEqual({});
  });

  it('stops at a removal that does not end in time and names its folder', async () => {
    privateCopy('a');
    privateCopy('b');
    const wipe = vi.fn((path: string, ms?: number) =>
      path === '/vaults/a'
        ? Promise.reject(new CoreTimeoutError('core', 'wipe', ms ?? 0))
        : Promise.resolve(),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const stuck = await sweepWithin('acct', { wipe } as unknown as CoreHandle, 5_000);
      expect(stuck).toBe('/vaults/a');
      // The next copy is left for the next start: it would queue behind the slow removal.
      expect(wipe).toHaveBeenCalledOnce();
      expect(Object.keys(readMarkers('acct')).sort()).toEqual(['a', 'b']);
    } finally {
      warn.mockRestore();
    }
  });
});
