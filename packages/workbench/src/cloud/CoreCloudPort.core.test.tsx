// The shared suites of @memobrain/cloud-features on CoreCloudPort over the real Go core
// (ADR-0045 §4, §7): the core compiled to WebAssembly runs in this Node process
// (test/wasmCore.ts, the harness of `task test-wasm`) and talks to the same fake cloud as the
// RestCloudPort's run (fakeCloudApi), checked against api/openapi.yaml on both sides. Where
// CoreCloudPort.test.tsx proves the components on the Wails mock, this proves the bindings, the Go
// client and the core's own rules (accepting prepares a mount, the device it runs on, the flags of
// the configuration it caches) behind the same components and the same assertions.
// Needs `task wasm-core`; runs with `task test-core` (vitest.core.config.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  cloudAccountSuite,
  cloudVaultsTableSuite,
  fakeCloudApi,
  type CloudSeed,
} from '@memobrain/cloud-features/testing';
import { contractFetch, type ContractFetch } from '@memobrain/cloud-features/testing/contract';
import { errorCode } from '@memobrain/cloud-features/port';
import { api } from '../app/api';
import { startWasmCore, wasmCoreBuilt, type WasmCore } from '../test/wasmCore';
import { CoreCloudPort } from './CoreCloudPort';

const ME = '0198f1c2-aaaa-7bbb-8ccc-0000000000ff'; // OWNER of the suites' seeds
/** The device the "page" remembers: the one the core runs as. */
const THIS_DEVICE = '0198f1c2-eeee-7bbb-8ccc-0000000000c0';

const me = {
  id: ME,
  username: 'me',
  email: 'me@example.com',
  display_name: 'Me',
  role: 'user',
  status: 'active',
  quota_bytes: -1,
  used_bytes: 0,
  config_version: 1,
  created_at: '2026-01-01T00:00:00Z',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The cloud of a test: fakeCloudApi (the suites' semantics) plus what the core asks for on its own
 * (the profile, its device), behind the contract of api/openapi.yaml.
 */
function cloudOf(seed: CloudSeed): ContractFetch {
  // The device marked as this one is the device the core runs as.
  const devices = seed.devices?.map((d) => (d.current ? { ...d, id: THIS_DEVICE } : d));
  const fake = fakeCloudApi({ ...seed, ...(devices ? { devices } : {}) });
  return contractFetch(async (req) => {
    const path = new URL(req.url).pathname.replace(/^\/api\/v1/, '');
    if (req.method === 'GET' && path === '/me') return json(200, me);
    if (req.method === 'POST' && path === '/me/devices')
      return json(201, {
        id: THIS_DEVICE,
        name: 'Test',
        platform: 'web',
        created_at: '2026-01-01T00:00:00Z',
      });
    return fake.fetch(req);
  });
}

let core: WasmCore | null = null;
let cloud: ContractFetch = cloudOf({});

/** The cloud of the next test; the core's caches that outlive a test are refreshed or cleared. */
async function cloudFor(seed: CloudSeed): Promise<CoreCloudPort> {
  cloud = cloudOf(seed);
  // Mount folders made by an earlier test would be listed as the copies of ended shares.
  if (core) rmSync(core.mountsDir, { recursive: true, force: true });
  await api.config.refresh();
  return new CoreCloudPort();
}

describe('CoreCloudPort on the Go core (WebAssembly)', () => {
  beforeAll(async () => {
    // Never a silent pass: without the core every test fails with this.
    if (!wasmCoreBuilt()) throw new Error('build the core first: task wasm-core');
    core = await startWasmCore({
      fetch: (req) => cloud.fetch(req),
      deviceId: THIS_DEVICE,
      userId: ME,
    });
  });
  afterAll(async () => {
    await core?.shutdown();
  });
  // Neither the core nor the fake strays from the contract.
  afterEach(() => {
    expect(cloud.problems).toEqual([]);
  });

  cloudVaultsTableSuite({
    name: 'CoreCloudPort (Go core)',
    setup: (seed) => cloudFor({ vaults: seed }),
  });

  cloudAccountSuite({
    name: 'CoreCloudPort (Go core)',
    knowsCurrentDevice: true,
    setup: (seed) => cloudFor(seed),
  });

  describe('the port on the core', () => {
    it('calls the documented operations', async () => {
      const port = await cloudFor({ vaults: [{ name: 'Team', kind: 'shared' }] });
      const [v] = await port.listVaults();
      await port.renameVault(v!.id, 'Crew');
      await port.listDevices();
      await port.getUsage();
      await port.listShares('owned');
      await port.listMounts();
      expect(cloud.calls).toEqual(
        expect.arrayContaining([
          'GET listVaults',
          'PATCH updateVault',
          'GET listMyDevices',
          'GET getMyUsage',
          'GET listShares',
          'GET listSharedWithMe',
        ]),
      );
    });

    it('rejects with the application code of the API', async () => {
      const port = await cloudFor({
        vaults: [
          { name: 'Notes', kind: 'shared' },
          { name: 'Work', kind: 'shared' },
        ],
      });
      const [v] = await port.listVaults();
      const err: unknown = await port.renameVault(v!.id, 'Work').catch((e: unknown) => e);
      expect(errorCode(err)).toBe('NAME_IN_USE');
    });
  });
});
