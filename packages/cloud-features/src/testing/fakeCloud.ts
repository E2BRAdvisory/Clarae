// An in-memory stand-in for the account endpoints of the cloud API (devices, usage, shares, grants,
// invitations, directory, groups, effective configuration) on top of the vault endpoints of
// fakeVaultApi: the RestCloudPort runs against it exactly as against the server (status codes,
// problem documents, D-02 on share creation, owner-only revoke, expiry in the future).
import type { CloudDevice, CloudUsage, GroupMembership, Share, SharePermission } from '../port';
import { fakeVaultApi, OWNER, type FakeVaultApi, type SeedVault } from './fakeRest';

export interface SeedDirectoryUser {
  id: string;
  username: string;
  display_name?: string;
}
export interface SeedDirectoryGroup {
  id: string;
  name: string;
  description?: string;
}

/** Everything a suite can put behind a port, in the API's own shapes. */
export interface CloudSeed {
  vaults?: SeedVault[];
  /** `current` marks the device the page runs on (the core knows it; the console is told). */
  devices?: CloudDevice[];
  usage?: CloudUsage;
  /** Shares created or managed by the user (their `vault_id` is an id of `vaults`, see vaultId). */
  owned?: Share[];
  received?: Share[];
  users?: SeedDirectoryUser[];
  groups?: SeedDirectoryGroup[];
  myGroups?: GroupMembership[];
  features?: Record<string, boolean>;
}

/** The id the fakes give the n-th seed vault (0-based), as seedVaults does. */
export const vaultId = (index: number) =>
  `0198f1c2-aaaa-7bbb-8ccc-${String(index + 1).padStart(12, '0')}`;

export const NOW = () => new Date().toISOString();

export interface FakeCloudApi extends FakeVaultApi {
  devices: CloudDevice[];
  owned: Share[];
  received: Share[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const problem = (status: number, code: string, detail: string): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

export function fakeCloudApi(seed: CloudSeed, basePath = '/api/v1'): FakeCloudApi {
  const vaultApi = fakeVaultApi(seed.vaults ?? [], basePath);
  // The server does not know which device the page is: it is the client that says so.
  const devices: CloudDevice[] = (seed.devices ?? []).map(({ current: _c, ...d }) => ({ ...d }));
  const usage: CloudUsage = seed.usage ?? { used_bytes: 0, quota_bytes: -1, level: 'ok' };
  const owned: Share[] = structuredClone(seed.owned ?? []);
  const received: Share[] = structuredClone(seed.received ?? []);
  const users = seed.users ?? [];
  const groups = seed.groups ?? [];
  let next = 1;

  const nameOf = (type: string, id: string) =>
    type === 'user'
      ? (users.find((u) => u.id === id)?.username ?? id)
      : (groups.find((g) => g.id === id)?.name ?? id);
  const future = (iso: string | undefined) => !iso || new Date(iso).getTime() > Date.now();

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.slice(basePath.length);
    if (path === '/vaults' || path.startsWith('/vaults/')) return vaultApi.fetch(req);
    vaultApi.calls.push(`${req.method} ${path}`);
    const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const q = url.searchParams.get('q')?.toLowerCase() ?? '';

    if (req.method === 'GET' && path === '/me/devices') return json(200, { items: devices });
    const dev = /^\/me\/devices\/([^/]+)$/.exec(path);
    if (dev && req.method === 'DELETE') {
      const d = devices.find((x) => x.id === dev[1]);
      if (!d || d.revoked_at) return problem(404, 'NOT_FOUND', 'device not found');
      d.revoked_at = NOW();
      return new Response(null, { status: 204 });
    }
    if (req.method === 'GET' && path === '/me/usage') return json(200, usage);
    if (req.method === 'GET' && path === '/me/groups') return json(200, seed.myGroups ?? []);
    if (req.method === 'GET' && path === '/config/effective')
      return json(200, {
        version: 1,
        config: seed.features ? { features: seed.features } : {},
        locked_keys: [],
      });
    if (req.method === 'GET' && path === '/directory/users')
      return json(
        200,
        users.filter(
          (u) => u.username.toLowerCase().includes(q) || u.display_name?.toLowerCase().includes(q),
        ),
      );
    if (req.method === 'GET' && path === '/directory/groups')
      return json(
        200,
        groups.filter((g) => g.name.toLowerCase().includes(q)),
      );

    if (req.method === 'GET' && path === '/shares')
      return json(200, url.searchParams.get('scope') === 'received' ? received : owned);
    if (req.method === 'POST' && path === '/shares') {
      const v = vaultApi.vaults.find((x) => x.id === body['vault_id'] && !x.deleted_at);
      if (!v) return problem(404, 'NOT_FOUND', 'vault not found');
      if (v.kind !== 'shared')
        return problem(409, 'VAULT_ENCRYPTED', 'private vaults cannot be shared');
      const name = (typeof body['display_name'] === 'string' ? body['display_name'] : '').trim();
      if (!name || name.length > 120) return problem(400, 'VALIDATION_FAILED', 'display_name');
      const expires = body['expires_at'] as string | undefined;
      if (!future(expires)) return problem(400, 'VALIDATION_FAILED', 'expires_at');
      const grants =
        (body['grants'] as {
          principal_type: 'user' | 'group';
          principal_id: string;
          permission: SharePermission;
        }[]) ?? [];
      const s: Share = {
        id: `0198f1c2-bbbb-7bbb-8ccc-${String(next++).padStart(12, '0')}`,
        vault_id: v.id,
        vault_name: v.name,
        resource_type: body['resource_type'] as Share['resource_type'],
        ...(body['path_prefix'] ? { path_prefix: body['path_prefix'] as string } : {}),
        display_name: name,
        owner_id: OWNER,
        owner_name: 'me',
        created_at: NOW(),
        ...(expires ? { expires_at: expires } : {}),
        grants: grants.map((g) => ({
          ...g,
          principal_name: nameOf(g.principal_type, g.principal_id),
          status: 'pending' as const,
          created_at: NOW(),
        })),
      };
      owned.push(s);
      return json(201, s);
    }
    const m = /^\/shares\/([^/:]+)(?::(accept|decline))?(?:\/grants\/(user|group)\/([^/]+))?$/.exec(
      path,
    );
    if (!m) return problem(404, 'NOT_FOUND', 'no such route');
    const [, id, answer, ptype, pid] = m;
    if (answer) {
      const s = received.find((x) => x.id === id);
      if (!s || req.method !== 'POST') return problem(404, 'NOT_FOUND', 'share not found');
      s.my_status = answer === 'accept' ? 'accepted' : 'declined';
      return json(200, s);
    }
    const s = owned.find((x) => x.id === id);
    if (!s) return problem(404, 'NOT_FOUND', 'share not found');
    if (ptype && pid) {
      s.grants ??= [];
      const i = s.grants.findIndex((g) => g.principal_type === ptype && g.principal_id === pid);
      if (req.method === 'DELETE') {
        if (i < 0) return problem(404, 'NOT_FOUND', 'grant not found');
        s.grants.splice(i, 1);
        return new Response(null, { status: 204 });
      }
      const permission = body['permission'] as SharePermission;
      const g =
        i >= 0
          ? Object.assign(s.grants[i]!, { permission })
          : {
              principal_type: ptype as 'user' | 'group',
              principal_id: pid,
              principal_name: nameOf(ptype, pid),
              permission,
              status: 'pending' as const,
              created_at: NOW(),
            };
      if (i < 0) s.grants.push(g);
      return json(200, g);
    }
    if (req.method === 'PATCH') {
      if (body['display_name'] !== undefined) {
        const name = (typeof body['display_name'] === 'string' ? body['display_name'] : '').trim();
        if (!name || name.length > 120) return problem(400, 'VALIDATION_FAILED', 'display_name');
        s.display_name = name;
      }
      if (body['clear_expiry'] === true) delete s.expires_at;
      else if (body['expires_at'] !== undefined) {
        if (!future(body['expires_at'] as string))
          return problem(400, 'VALIDATION_FAILED', 'expires_at must be in the future');
        s.expires_at = body['expires_at'] as string;
      }
      return json(200, s);
    }
    if (req.method === 'DELETE') {
      if (s.my_permission) return problem(403, 'FORBIDDEN', 'only the owner can revoke a share');
      owned.splice(owned.indexOf(s), 1);
      return new Response(null, { status: 204 });
    }
    return problem(404, 'NOT_FOUND', 'no such route');
  };
  return { ...vaultApi, fetch: handle, devices, owned, received };
}
