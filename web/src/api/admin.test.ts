import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { adminKeys, invalidateConfigResolution } from './admin';

describe('invalidateConfigResolution', () => {
  it('marks every resolved configuration stale, and nothing else', async () => {
    const qc = new QueryClient();
    const keys = {
      adminConfig: adminKeys.userPart('u1', 'config'),
      otherConfig: adminKeys.userPart('u2', 'config'),
      own: ['config', 'effective'],
      // The flags as @memobrain/cloud-features caches them (the Shares link, the workbench).
      flags: ['cloud-features', 'rest', 'features'],
      devices: adminKeys.userPart('u1', 'devices'),
      profiles: adminKeys.profiles,
      vaults: ['cloud-features', 'rest', 'vaults'],
    };
    for (const k of Object.values(keys)) qc.setQueryData(k, {});
    await invalidateConfigResolution(qc);
    const stale = (k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated;
    expect(stale(keys.adminConfig)).toBe(true);
    expect(stale(keys.otherConfig)).toBe(true);
    expect(stale(keys.own)).toBe(true);
    expect(stale(keys.flags)).toBe(true);
    expect(stale(keys.devices)).toBe(false);
    expect(stale(keys.profiles)).toBe(false);
    expect(stale(keys.vaults)).toBe(false);
  });
});
