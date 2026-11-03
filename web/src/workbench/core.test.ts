import { describe, expect, it } from 'vitest';
import { BINDINGS, coreClient, type CoreCaller } from './core.gen';

/** A core that records the calls it gets. */
function recorder() {
  const calls: unknown[][] = [];
  const core: CoreCaller = {
    callWithin: <T>(ms: number, service: string, method: string, ...args: unknown[]) => {
      calls.push([ms, service, method, ...args]);
      return Promise.resolve({ service, method } as T);
    },
  };
  return { core, calls };
}

describe('coreClient (core.gen.ts)', () => {
  it('calls the binding by its service and method, with the time limit', async () => {
    const { core, calls } = recorder();
    await coreClient(core, 5_000).VaultAPI.OpenVault('/vaults/x');
    await coreClient(core).SyncAPI.LinkExisting('local', 'cloud');
    expect(calls).toEqual([
      [5_000, 'VaultAPI', 'OpenVault', '/vaults/x'],
      [0, 'SyncAPI', 'LinkExisting', 'local', 'cloud'],
    ]);
  });

  it('has a method for every binding the generator listed', async () => {
    const { core, calls } = recorder();
    const client = coreClient(core, 1) as unknown as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    for (const [service, methods] of Object.entries(BINDINGS)) {
      expect(Object.keys(client[service]!).sort()).toEqual([...methods].sort());
      for (const m of methods) await client[service]![m]!();
    }
    expect(calls.length).toBe(Object.values(BINDINGS).flat().length);
    expect(calls.every(([ms]) => ms === 1)).toBe(true);
  });
});
