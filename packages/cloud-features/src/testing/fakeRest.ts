// An in-memory stand-in for the vault endpoints of the cloud API, as a `fetch` for openapi-fetch:
// the RestCloudPort runs against it exactly as against the server (status codes, problem documents,
// the owner's name uniqueness among live vaults, restore of deleted vaults only).
import type { CloudVault } from '../port';

export interface SeedVault {
  name: string;
  kind: 'shared' | 'private';
  /** Soft-deleted (deleted_at set) at this time, or now when `true`. */
  deleted?: boolean | string;
  total_bytes?: number;
  file_count?: number;
}

export const OWNER = '0198f1c2-aaaa-7bbb-8ccc-0000000000ff';

/** The API's view of a seed, with a stable id per position. */
export function seedVaults(seed: SeedVault[]): CloudVault[] {
  return seed.map((s, i) => ({
    id: `0198f1c2-aaaa-7bbb-8ccc-${String(i + 1).padStart(12, '0')}`,
    owner_id: OWNER,
    name: s.name,
    kind: s.kind,
    last_seq: 1,
    total_bytes: s.total_bytes ?? 0,
    file_count: s.file_count ?? 0,
    created_at: '2026-10-01T10:00:00Z',
    ...(s.deleted
      ? { deleted_at: typeof s.deleted === 'string' ? s.deleted : new Date().toISOString() }
      : {}),
  }));
}

export interface FakeVaultApi {
  fetch: (input: Request) => Promise<Response>;
  vaults: CloudVault[];
  /** "METHOD /path" of every request, for assertions. */
  calls: string[];
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

export function fakeVaultApi(seed: SeedVault[], basePath = '/api/v1'): FakeVaultApi {
  const vaults = seedVaults(seed);
  const calls: string[] = [];
  const taken = (name: string, except?: string) =>
    vaults.some((v) => v.name === name && !v.deleted_at && v.id !== except);

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.slice(basePath.length);
    calls.push(`${req.method} ${path}`);
    const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.text();
    const input = body ? (JSON.parse(body) as { name?: string; kind?: string }) : {};
    if (path === '/vaults' && req.method === 'GET') {
      const all = url.searchParams.get('include_deleted') === 'true';
      return json(200, { items: vaults.filter((v) => all || !v.deleted_at), mounts: [] });
    }
    if (path === '/vaults' && req.method === 'POST') {
      const name = (input.name ?? '').trim();
      if (!name || name.length > 120) return problem(400, 'VALIDATION_FAILED', 'name');
      if (taken(name)) return problem(409, 'NAME_IN_USE', 'a vault with this name exists');
      if (input.kind !== 'shared') return problem(400, 'VALIDATION_FAILED', 'key_envelopes');
      const v: CloudVault = {
        ...seedVaults([{ name, kind: 'shared' }])[0]!,
        id: `0198f1c2-aaaa-7bbb-8ccc-${String(900 + vaults.length).padStart(12, '0')}`,
      };
      vaults.push(v);
      return json(201, v);
    }
    const m = /^\/vaults\/([^/:]+)(:restore)?$/.exec(path);
    const v = m ? vaults.find((x) => x.id === decodeURIComponent(m[1] as string)) : undefined;
    if (!m || !v) return problem(404, 'NOT_FOUND', 'vault not found');
    if (m[2]) {
      if (req.method !== 'POST' || !v.deleted_at) return problem(404, 'NOT_FOUND', 'not deleted');
      if (taken(v.name, v.id)) return problem(409, 'NAME_IN_USE', 'a vault with this name exists');
      delete v.deleted_at;
      return json(200, v);
    }
    if (v.deleted_at) return problem(404, 'NOT_FOUND', 'vault not found');
    if (req.method === 'PATCH') {
      const name = (input.name ?? '').trim();
      if (!name || name.length > 120) return problem(400, 'VALIDATION_FAILED', 'name');
      if (taken(name, v.id)) return problem(409, 'NAME_IN_USE', 'a vault with this name exists');
      v.name = name;
      return json(200, v);
    }
    if (req.method === 'DELETE') {
      v.deleted_at = new Date().toISOString();
      return new Response(null, { status: 204 });
    }
    return problem(404, 'NOT_FOUND', 'no such route');
  };
  return { fetch: handle, vaults, calls };
}
