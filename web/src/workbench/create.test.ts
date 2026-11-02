import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreHandle } from './bridge';
import { folderOf, parseCreation, runCreation, type MountCreate } from './create';
import { clearMarkers, readMarkers, updateMarker } from './markers';

/** The account's storage key (storage.ts). */
const A = 'a-alice';

afterEach(() => clearMarkers(A));

const q = (s: string) => new URLSearchParams(s);

describe('parseCreation', () => {
  it('reads the creation route', () => {
    expect(parseCreation('new', q('kind=private&name=%20My%20diary%20'))).toEqual({
      kind: 'private',
      name: 'My diary',
    });
    expect(parseCreation('0198f1c2-aaaa', q('kind=private&name=x'))).toBeNull();
  });

  it('refuses what it cannot create', () => {
    expect(parseCreation('new', q('kind=shared&name=x'))).toBe('invalid');
    expect(parseCreation('new', q('kind=private'))).toBe('invalid');
    expect(parseCreation('new', q(`kind=private&name=${'x'.repeat(121)}`))).toBe('invalid');
  });
});

describe('folderOf', () => {
  it('follows the marker of a copy created in this browser', () => {
    expect(folderOf(A, 'c1')).toBe('/vaults/c1');
    updateMarker(A, 'c1', { kind: 'private', localPath: '/vaults/new-abc' });
    expect(folderOf(A, 'c1')).toBe('/vaults/new-abc');
    updateMarker(A, 'c2', { kind: 'shared', localPath: '/elsewhere/c2' });
    expect(folderOf(A, 'c2')).toBe('/vaults/c2');
  });
});

function fakeCore() {
  const calls: string[] = [];
  const core = {
    callWithin: vi.fn((_ms: number, service: string, method: string, ...args: unknown[]) => {
      calls.push(`${service}.${method} ${args.join(' ')}`);
      if (method === 'OpenVault')
        return Promise.resolve({ id: 'local-1', name: 'new-abc', path: args[0] });
      return Promise.resolve(null);
    }),
    wipe: vi.fn((_path: string) => Promise.resolve()),
  };
  return {
    core: core as unknown as Pick<CoreHandle, 'callWithin' | 'wipe'>,
    calls,
    wipe: core.wipe,
  };
}

describe('runCreation', () => {
  it('creates in a folder of its own, then hands the copy to the new cloud vault', async () => {
    const { core, calls, wipe } = fakeCore();
    const replaceUrl = vi.fn();
    const unmount = vi.fn();
    let seen: MountCreate | undefined;
    const done = runCreation({
      account: A,
      core,
      creation: { kind: 'private', name: 'Diary' },
      newId: () => 'abc',
      replaceUrl,
      mount: (o) => {
        seen = o;
        // While the wizard is up, a closed tab leaves a private copy the next start-up sweeps.
        expect(readMarkers(A)['new-abc']).toMatchObject({
          kind: 'private',
          localPath: '/vaults/new-abc',
        });
        setTimeout(() => o.onCreated('cloud-1'), 0);
        return Promise.resolve(unmount);
      },
    });
    expect(await done).toEqual({ vaultId: 'cloud-1', path: '/vaults/new-abc' });
    expect(seen).toMatchObject({ vaultId: 'local-1', name: 'Diary', kind: 'private' });
    expect(unmount).toHaveBeenCalled();
    expect(calls).toEqual(['VaultAPI.OpenVault /vaults/new-abc', 'VaultAPI.CloseVault local-1']);
    expect(replaceUrl).toHaveBeenCalledWith('/vaults/cloud-1/open');
    expect(wipe).not.toHaveBeenCalled();
    expect(Object.keys(readMarkers(A))).toEqual(['cloud-1']);
    expect(folderOf(A, 'cloud-1')).toBe('/vaults/new-abc');
  });

  it('cancelled: removes the empty folder and its marker', async () => {
    const { core, wipe } = fakeCore();
    const replaceUrl = vi.fn();
    const result = await runCreation({
      account: A,
      core,
      creation: { kind: 'private', name: 'Diary' },
      newId: () => 'abc',
      replaceUrl,
      mount: (o) => {
        setTimeout(() => o.onCancel(), 0);
        return Promise.resolve(() => undefined);
      },
    });
    expect(result).toBeNull();
    expect(wipe).toHaveBeenCalledWith('/vaults/new-abc');
    expect(readMarkers(A)).toEqual({});
    expect(replaceUrl).not.toHaveBeenCalled();
  });
});
