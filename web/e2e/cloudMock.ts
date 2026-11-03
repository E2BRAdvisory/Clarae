import { createHash, randomUUID } from 'node:crypto';
import type { BrowserContext, Request, Route } from '@playwright/test';
import {
  jsonSchemaOf,
  operationOf,
  requestSchemaOf,
  responseOf,
  validate,
} from '@memobrain/cloud-features/testing/contract';

/**
 * A cloud of the REST API (api/openapi.yaml) in the test process, so the cloud panels of the
 * workbench run on the real Go core in the browser (ADR-0045 §4): the core, in its Web Worker,
 * calls /api/v1 like it calls a real cloud, and `context.route` answers (a route of the context also
 * sees the requests of the page's workers, which `page.route` does not).
 *
 * The mock keeps a small state (account, vaults, devices, usage, shares, directory, files of a
 * vault or of a share) and implements the operations the panels and the sync of an open vault use.
 * Every request is matched to an operation of the OpenAPI document; its JSON body and every JSON
 * answer are validated against the schemas of that operation. A violation, an operation the mock
 * does not implement or a path outside the document is recorded in `problems` and answered with a
 * problem+json error, so a test that asserts `problems` is empty fails on any drift between the
 * core and the contract. The notification stream (`/events`, not a REST operation) is refused:
 * the core falls back to polling.
 */

export const ME = '11111111-1111-4111-8111-111111111111';
const EPOCH = '2026-10-01T10:00:00Z';

type Json = Record<string, unknown>;

/** The account as GET /me returns it. */
export interface CloudMe extends Json {
  id: string;
  username: string;
  email: string;
  display_name?: string;
  role: 'admin' | 'user';
}

export interface CloudVault extends Json {
  id: string;
  owner_id: string;
  name: string;
  kind: 'private' | 'shared';
  last_seq: number;
  total_bytes: number;
  file_count: number;
  created_at: string;
  deleted_at?: string;
}

export interface CloudDevice extends Json {
  id: string;
  name: string;
  platform: string;
  app_version?: string;
  created_at: string;
  last_seen_at?: string;
  revoked_at?: string;
}

export interface CloudGrant extends Json {
  principal_type: 'user' | 'group';
  principal_id: string;
  principal_name: string;
  permission: 'viewer' | 'editor' | 'manager';
  status: 'pending' | 'accepted' | 'declined';
  created_at: string;
}

export interface CloudShare extends Json {
  id: string;
  vault_id: string;
  vault_name: string;
  resource_type: 'vault' | 'folder' | 'file';
  path_prefix?: string;
  display_name: string;
  owner_id: string;
  owner_name: string;
  created_at: string;
  expires_at?: string;
  my_permission?: 'viewer' | 'editor' | 'manager';
  my_status?: 'pending' | 'accepted' | 'declined';
  grants?: CloudGrant[];
}

export interface CloudSeed {
  me?: Partial<CloudMe>;
  /** `config` of GET /config/effective (feature flags under `features`) and its locked keys. */
  config?: { config?: Json; locked_keys?: string[] };
  vaults?: CloudVault[];
  devices?: CloudDevice[];
  usage?: {
    used_bytes: number;
    quota_bytes: number;
    level: 'ok' | 'warning' | 'critical' | 'full';
  };
  /** Shares the account owns or manages, and those it received (`my_status` set, another owner). */
  shares?: CloudShare[];
  directory?: {
    users?: { id: string; username: string; display_name?: string }[];
    groups?: { id: string; name: string; description?: string }[];
  };
  /** Text files of a vault (by vault id) or of a share (by share id, paths inside the share). */
  files?: Record<string, Record<string, string>>;
}

interface StoredFile {
  file_id: string;
  rev: number;
  hash: string;
  size: number;
  kind: string;
}
interface Space {
  files: Map<string, StoredFile>;
  changes: Json[];
}

export interface CloudMock {
  /** The state the mock serves; tests read it to check what the client sent. */
  readonly state: {
    me: CloudMe;
    config: { version: number; config: Json; locked_keys: string[] };
    vaults: CloudVault[];
    devices: CloudDevice[];
    usage: NonNullable<CloudSeed['usage']>;
    shares: CloudShare[];
    directory: Required<NonNullable<CloudSeed['directory']>>;
  };
  /** "METHOD operationId" of every request served, in order. */
  readonly calls: string[];
  /** Contract violations, unimplemented operations and unknown paths (empty when all is well). */
  readonly problems: string[];
  /** Deletes a vault "elsewhere" (the console, another device): later requests on it answer 404. */
  deleteVaultElsewhere(id: string): void;
}

// ---- the contract ----------------------------------------------------------------------------
// Matching and validation are those of @memobrain/cloud-features/testing/contract, shared with the
// run of the cloud suites on the Go core in Node (CoreCloudPort.core.test.tsx).

// ---- helpers ------------------------------------------------------------------------------------

const now = (): string => new Date().toISOString();
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const problem = (status: number, code: string, detail: string): Json => ({
  type: 'about:blank',
  title: detail,
  status,
  code,
  detail,
});

/** Vault ids, device ids and share ids of the fixtures: UUIDs, as the contract says. */
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** A vault of the account (REST shape). */
export function cloudVault(
  id: string,
  name: string,
  kind: 'private' | 'shared',
  bytes = 2048,
): CloudVault {
  return {
    id,
    owner_id: ME,
    name,
    kind,
    last_seq: 0,
    total_bytes: bytes,
    file_count: 2,
    created_at: EPOCH,
  };
}

// ---- the mock -------------------------------------------------------------------------------------

/**
 * Installs the mock on a browser context (before the page opens). The pages of the context are
 * signed in with the E2E double (web/src/auth/e2e.ts) as the account of the state.
 */
export async function installCloudMock(
  context: BrowserContext,
  seed: CloudSeed = {},
): Promise<CloudMock> {
  const state: CloudMock['state'] = {
    me: {
      id: ME,
      username: 'alice',
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'user',
      ...seed.me,
    },
    config: {
      version: 1,
      config: seed.config?.config ?? {},
      locked_keys: seed.config?.locked_keys ?? [],
    },
    vaults: structuredClone(seed.vaults ?? []),
    devices: structuredClone(seed.devices ?? []),
    usage: seed.usage ?? { used_bytes: 0, quota_bytes: -1, level: 'ok' },
    shares: structuredClone(seed.shares ?? []),
    directory: { users: seed.directory?.users ?? [], groups: seed.directory?.groups ?? [] },
  };
  const calls: string[] = [];
  const problems: string[] = [];
  const blobs = new Map<string, Buffer>();
  const spaces = new Map<string, Space>();
  const deletedElsewhere = new Set<string>();

  const space = (key: string): Space => {
    let s = spaces.get(key);
    if (!s) spaces.set(key, (s = { files: new Map(), changes: [] }));
    return s;
  };
  const record = (
    key: string,
    op: string,
    path: string,
    f: StoredFile,
    extra: Json = {},
  ): number => {
    const s = space(key);
    const seq = s.changes.length + 1;
    s.changes.push({
      seq,
      id: randomUUID(),
      file_id: f.file_id,
      op,
      path,
      rev: f.rev,
      blob_hash: f.hash,
      size: f.size,
      author_id: ME,
      server_time: now(),
      ...extra,
    });
    const v = state.vaults.find((x) => x.id === key);
    if (v) v.last_seq = seq;
    return seq;
  };
  for (const [key, files] of Object.entries(seed.files ?? {})) {
    for (const [path, text] of Object.entries(files)) {
      const data = Buffer.from(text);
      const hash = sha256(data);
      blobs.set(hash, data);
      const f: StoredFile = {
        file_id: randomUUID(),
        rev: 1,
        hash,
        size: data.length,
        kind: 'file',
      };
      space(key).files.set(path, f);
      record(key, 'create', path, f);
    }
  }

  const ownedShares = () =>
    state.shares.filter(
      (s) =>
        s.owner_id === state.me.id || (s.my_permission === 'manager' && s.my_status === 'accepted'),
    );
  const receivedShares = () =>
    state.shares.filter((s) => s.owner_id !== state.me.id && s.my_status !== undefined);
  const vaultOf = (id: string) => state.vaults.find((v) => v.id === id && !v.deleted_at);
  /** The files of a request: a share's own space with `scope=share:<id>`, the vault's otherwise. */
  const spaceKey = (vaultId: string, url: URL) => {
    const scope = url.searchParams.get('scope');
    return scope?.startsWith('share:') ? scope.slice(6) : vaultId;
  };
  /** Whether the account reaches the files of a vault: its own, or through an accepted share. */
  const reaches = (vaultId: string, url: URL) => {
    const scope = url.searchParams.get('scope');
    if (!scope) return Boolean(vaultOf(vaultId));
    const share = receivedShares().find((x) => `share:${x.id}` === scope);
    return share?.vault_id === vaultId && share.my_status === 'accepted';
  };

  type Out = { status: number; body?: unknown; raw?: Buffer; headers?: Record<string, string> };
  type Impl = (p: Record<string, string>, url: URL, body: unknown, req: Request) => Out;
  const ok = (body?: unknown, status = 200): Out =>
    body === undefined ? { status: 204 } : { status, body };
  const notFound = (what: string): Out => ({
    status: 404,
    body: problem(404, 'NOT_FOUND', `${what} not found`),
  });

  const impl: Record<string, Impl> = {
    getMe: () =>
      ok({
        status: 'active',
        quota_bytes: state.usage.quota_bytes,
        used_bytes: state.usage.used_bytes,
        config_version: state.config.version,
        created_at: EPOCH,
        ...state.me,
      }),
    // With its ETag: the core asks again with If-None-Match and a 304 means nothing changed.
    getEffectiveConfig: (_p, _u, _b, req) => {
      const etag = `"config-${state.config.version}"`;
      if (req.headers()['if-none-match'] === etag) return { status: 304, headers: { ETag: etag } };
      return { status: 200, body: state.config, headers: { ETag: etag } };
    },
    getMyUsage: () => ok(state.usage),
    listMyGroups: () => ok([]),
    // The server lists the active devices only: a revoked one disappears.
    listMyDevices: () => ok({ items: state.devices.filter((d) => !d.revoked_at) }),
    registerDevice: (_p, _u, body) => {
      const b = body as { name: string; platform: string; app_version?: string };
      const d: CloudDevice = {
        id: randomUUID(),
        name: b.name,
        platform: b.platform,
        created_at: now(),
        last_seen_at: now(),
        ...(b.app_version ? { app_version: b.app_version } : {}),
      };
      state.devices.push(d);
      return ok(d, 201);
    },
    revokeDevice: ({ deviceId }) => {
      const d = state.devices.find((x) => x.id === deviceId && !x.revoked_at);
      if (!d) return notFound('device');
      d.revoked_at = now();
      return ok();
    },
    listVaults: (_p, url) => {
      const deleted = url.searchParams.get('include_deleted') === 'true';
      return ok({
        items: state.vaults.filter((v) => deleted || !v.deleted_at),
        mounts: [],
      });
    },
    getVault: ({ vaultId }) => {
      const v = vaultOf(vaultId!);
      return v ? ok(v) : notFound('vault');
    },
    updateVault: ({ vaultId }, _u, body) => {
      const v = vaultOf(vaultId!);
      if (!v) return notFound('vault');
      v.name = (body as { name: string }).name;
      return ok(v);
    },
    deleteVault: ({ vaultId }) => {
      const v = vaultOf(vaultId!);
      if (!v) return notFound('vault');
      v.deleted_at = now();
      return ok();
    },
    restoreVault: ({ vaultId }) => {
      const v = state.vaults.find((x) => x.id === vaultId && x.deleted_at);
      if (!v) return notFound('deleted vault');
      delete v.deleted_at;
      deletedElsewhere.delete(v.id);
      return ok(v);
    },
    getVaultTree: ({ vaultId }, url) => {
      if (!reaches(vaultId!, url)) return notFound('vault');
      const s = space(spaceKey(vaultId!, url));
      const last = s.changes.at(-1);
      return ok({
        items: [...s.files].map(([path, f]) => ({ path, ...f })),
        as_of_seq: s.changes.length,
        ...(last ? { as_of_id: last['id'] } : {}),
      });
    },
    getChanges: ({ vaultId }, url) => {
      if (!reaches(vaultId!, url)) return notFound('vault');
      const s = space(spaceKey(vaultId!, url));
      const since = Number(url.searchParams.get('since') ?? 0);
      const items = s.changes
        .filter((ch) => (ch['seq'] as number) > since)
        .map(({ id: _id, ...ch }) => ch);
      const last = s.changes.at(-1);
      return ok({
        items,
        next_seq: s.changes.length,
        ...(last ? { next_id: last['id'] } : {}),
        has_more: false,
      });
    },
    checkBlobs: (_p, _u, body) =>
      ok({ missing: (body as { hashes: string[] }).hashes.filter((h) => !blobs.has(h)) }),
    putBlob: ({ sha256: hash }, _u, _b, req) => {
      blobs.set(hash!, req.postDataBuffer() ?? Buffer.alloc(0));
      return ok();
    },
    getBlob: ({ sha256: hash }) => {
      const data = blobs.get(hash!);
      return data ? { status: 200, raw: data } : notFound('blob');
    },
    commit: ({ vaultId }, url, body) => {
      if (!reaches(vaultId!, url)) return notFound('vault');
      const key = spaceKey(vaultId!, url);
      const s = space(key);
      const results: Json[] = [];
      for (const op of (body as { ops: Json[] }).ops) {
        const opId = op['op_id'] as string;
        const kind = op['op'] as string;
        const path = (op['path'] ?? op['to']) as string;
        if (kind === 'create' || kind === 'modify' || kind === 'restore') {
          const prev = s.files.get(path);
          const f: StoredFile = {
            file_id: prev?.file_id ?? (op['file_id'] as string | undefined) ?? randomUUID(),
            rev: (prev?.rev ?? 0) + 1,
            hash: op['blob_hash'] as string,
            size: (op['size'] as number) ?? 0,
            kind: 'file',
          };
          s.files.set(path, f);
          const seq = record(key, prev ? 'modify' : 'create', path, f);
          results.push({ op_id: opId, status: 'accepted', file_id: f.file_id, rev: f.rev, seq });
        } else if (kind === 'delete') {
          const p = [...s.files].find(([, f]) => f.file_id === op['file_id'])?.[0] ?? path;
          const f = s.files.get(p);
          if (f) {
            s.files.delete(p);
            const seq = record(key, 'delete', p, { ...f, rev: f.rev + 1 });
            results.push({
              op_id: opId,
              status: 'accepted',
              file_id: f.file_id,
              rev: f.rev + 1,
              seq,
            });
          } else results.push({ op_id: opId, status: 'accepted' });
        } else if (kind === 'move') {
          const from = op['from'] as string;
          const f = s.files.get(from);
          if (f) {
            s.files.delete(from);
            const moved = { ...f, rev: f.rev + 1 };
            s.files.set(op['to'] as string, moved);
            const seq = record(key, 'move', op['to'] as string, moved, { prev_path: from });
            results.push({
              op_id: opId,
              status: 'accepted',
              file_id: f.file_id,
              rev: moved.rev,
              seq,
            });
          } else
            results.push({
              op_id: opId,
              status: 'rejected',
              code: 'NOT_FOUND',
              detail: 'no such file',
            });
        } else
          results.push({
            op_id: opId,
            status: 'rejected',
            code: 'VALIDATION_FAILED',
            detail: kind,
          });
      }
      return ok({ results, last_seq: s.changes.length });
    },
    // A page as the server answers it (api/openapi.yaml, Pagination); the cursor is an index.
    listShares: (_p, url) => {
      const all = url.searchParams.get('scope') === 'owned' ? ownedShares() : receivedShares();
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const from = Number(url.searchParams.get('cursor') ?? 0);
      const items = all.slice(from, from + limit);
      return ok(
        from + limit < all.length ? { items, next_cursor: String(from + limit) } : { items },
      );
    },
    getShare: ({ shareId }) => {
      const s = state.shares.find((x) => x.id === shareId);
      return s ? ok(s) : notFound('share');
    },
    createShare: (_p, _u, body) => {
      const b = body as {
        vault_id: string;
        resource_type: CloudShare['resource_type'];
        path_prefix?: string;
        display_name: string;
        expires_at?: string;
      };
      const own = vaultOf(b.vault_id);
      // A manager shares inside the share they manage: the new share is the vault owner's (ADR-0041 §8).
      const managed = ownedShares().find(
        (s) =>
          s.vault_id === b.vault_id &&
          s.owner_id !== state.me.id &&
          (b.path_prefix ?? '').startsWith(s.path_prefix ?? ''),
      );
      if (!own && !managed) return notFound('vault');
      const share: CloudShare = {
        id: randomUUID(),
        vault_id: b.vault_id,
        vault_name: own?.name ?? managed!.vault_name,
        resource_type: b.resource_type,
        ...(b.path_prefix ? { path_prefix: b.path_prefix } : {}),
        display_name: b.display_name,
        owner_id: own ? state.me.id : managed!.owner_id,
        owner_name: own ? state.me.username : managed!.owner_name,
        created_at: now(),
        ...(b.expires_at ? { expires_at: b.expires_at } : {}),
        ...(own ? {} : { my_permission: 'manager' as const, my_status: 'accepted' as const }),
        grants: [],
      };
      state.shares.push(share);
      return ok(share, 201);
    },
    updateShare: ({ shareId }, _u, body) => {
      const s = state.shares.find((x) => x.id === shareId);
      if (!s) return notFound('share');
      const b = body as { display_name?: string; expires_at?: string; clear_expiry?: boolean };
      if (b.display_name) s.display_name = b.display_name;
      if (b.expires_at) s.expires_at = b.expires_at;
      if (b.clear_expiry) delete s.expires_at;
      return ok(s);
    },
    revokeShare: ({ shareId }) => {
      const i = state.shares.findIndex((x) => x.id === shareId);
      if (i < 0) return notFound('share');
      state.shares.splice(i, 1);
      return ok();
    },
    putGrant: ({ shareId, principalType, principalId }, _u, body) => {
      const s = state.shares.find((x) => x.id === shareId);
      if (!s) return notFound('share');
      const name =
        principalType === 'group'
          ? state.directory.groups.find((g) => g.id === principalId)?.name
          : state.directory.users.find((u) => u.id === principalId)?.username;
      if (!name) return notFound('principal');
      s.grants = (s.grants ?? []).filter((g) => g.principal_id !== principalId);
      const grant: CloudGrant = {
        principal_type: principalType as CloudGrant['principal_type'],
        principal_id: principalId!,
        principal_name: name,
        permission: (body as { permission: CloudGrant['permission'] }).permission,
        status: 'pending',
        created_at: now(),
      };
      s.grants.push(grant);
      return ok(grant);
    },
    deleteGrant: ({ shareId, principalId }) => {
      const s = state.shares.find((x) => x.id === shareId);
      if (!s) return notFound('share');
      s.grants = (s.grants ?? []).filter((g) => g.principal_id !== principalId);
      return ok();
    },
    acceptShare: ({ shareId }) => {
      const s = receivedShares().find((x) => x.id === shareId);
      if (!s) return notFound('share');
      s.my_status = 'accepted';
      return ok(s);
    },
    declineShare: ({ shareId }) => {
      const s = receivedShares().find((x) => x.id === shareId);
      if (!s) return notFound('share');
      s.my_status = 'declined';
      return ok(s);
    },
    listSharedWithMe: (_p, url) => {
      const all = receivedShares()
        .filter((s) => s.my_status === 'accepted')
        .map((s) => ({
          share_id: s.id,
          vault_id: s.vault_id,
          display_name: s.display_name,
          resource_type: s.resource_type,
          permission: s.my_permission ?? 'viewer',
          scope: `share:${s.id}`,
          owner_name: s.owner_name,
          ...(s.expires_at ? { expires_at: s.expires_at } : {}),
        }));
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const from = Number(url.searchParams.get('cursor') ?? 0);
      const items = all.slice(from, from + limit);
      return ok(
        from + limit < all.length ? { items, next_cursor: String(from + limit) } : { items },
      );
    },
    searchDirectoryUsers: (_p, url) => {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return ok(
        state.directory.users.filter((u) =>
          `${u.username} ${u.display_name ?? ''}`.toLowerCase().includes(q),
        ),
      );
    },
    searchDirectoryGroups: (_p, url) => {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return ok(state.directory.groups.filter((g) => g.name.toLowerCase().includes(q)));
    },
  };

  async function handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const answer = async (out: Out) => {
      const headers = out.headers ?? {};
      if (out.raw)
        return route.fulfill({
          status: out.status,
          headers,
          contentType: 'application/octet-stream',
          body: out.raw,
        });
      if (out.body === undefined) return route.fulfill({ status: out.status, headers });
      const contentType = out.status >= 400 ? 'application/problem+json' : 'application/json';
      return route.fulfill({
        status: out.status,
        headers,
        contentType,
        body: JSON.stringify(out.body),
      });
    };
    // The notification stream is not an operation of the REST contract: the core polls instead.
    if (path === '/events')
      return answer({ status: 404, body: problem(404, 'NOT_FOUND', 'no notification stream') });
    const match = operationOf(req.method(), path);
    if (!match) {
      problems.push(`${req.method()} ${path}: not an operation of api/openapi.yaml`);
      return answer({ status: 404, body: problem(404, 'NOT_FOUND', 'unknown path') });
    }
    const { op: o, params } = match;
    calls.push(`${o.method} ${o.id}`);
    let body: unknown;
    const reqSchema = requestSchemaOf(o);
    if (reqSchema) {
      try {
        body = JSON.parse(req.postData() ?? 'null');
      } catch {
        problems.push(`${o.id}: the request body is not JSON`);
      }
      const err = validate(reqSchema, body);
      if (err) {
        problems.push(`${o.id}: request ${err}`);
        return answer({ status: 400, body: problem(400, 'VALIDATION_FAILED', err) });
      }
    }
    const run = impl[o.id];
    if (!run) {
      problems.push(`${o.id}: not implemented by the cloud mock`);
      return answer({ status: 501, body: problem(501, 'INTERNAL', `${o.id} is not mocked`) });
    }
    let out: Out;
    const vaultId = params['vaultId'];
    if (vaultId && deletedElsewhere.has(vaultId) && o.id !== 'restoreVault')
      out = notFound('vault');
    else out = run(params, url, body, req);
    const declared = responseOf(o, out.status);
    if (!declared)
      problems.push(`${o.id}: status ${out.status} is not a response of the operation`);
    else if (out.body !== undefined) {
      const schema = jsonSchemaOf(declared);
      const err = schema ? validate(schema, out.body) : null;
      if (err) problems.push(`${o.id}: response ${out.status} ${err}`);
    }
    return answer(out);
  }

  await context.route('**/api/v1/**', handle);
  return {
    state,
    calls,
    problems,
    deleteVaultElsewhere(id: string) {
      const v = state.vaults.find((x) => x.id === id);
      if (v) v.deleted_at = now();
      deletedElsewhere.add(id);
    },
  };
}
