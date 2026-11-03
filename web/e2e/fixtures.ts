import { type Route } from '@playwright/test';
import { BOB, ME } from './support';

// Shared API fixtures for the accessibility and keyboard e2e suites.
const MB = 1024 * 1024;
export const U1 = '11111111-aaaa-4111-8111-111111111111';
export const G = '33333333-aaaa-4333-8333-333333333333';
export const P = '44444444-aaaa-4444-8444-444444444444';
export const V_SHARED = 's1';
export const V_PRIVATE = 'p1';

export const adminUser = (id = U1, username = 'alice') => ({
  id,
  username,
  email: `${username}@example.com`,
  display_name: username[0]?.toUpperCase() + username.slice(1),
  role: 'user',
  status: 'active',
  quota_bytes: 100 * MB,
  quota_bytes_override: null,
  used_bytes: MB,
  created_at: '2026-01-01T00:00:00Z',
});

const group = {
  id: G,
  name: 'Team',
  description: 'The team',
  member_count: 1,
  created_at: '2026-01-01T00:00:00Z',
};
const profile = {
  id: P,
  name: 'Base',
  description: 'Defaults',
  is_global: false,
  version: 2,
  config: { editor: { fontSize: 16 } },
  locked_keys: ['editor.fontSize'],
  updated_at: '2026-02-01T10:00:00Z',
};
const vault = (id: string, kind: string, name: string) => ({
  id,
  owner_id: ME,
  name,
  kind,
  last_seq: 1,
  total_bytes: 10,
  file_count: 1,
  created_at: '2026-01-01T00:00:00Z',
});
const shareCommon = {
  vault_id: V_SHARED,
  vault_name: 'Docs',
  resource_type: 'folder',
  created_at: '2026-01-01T00:00:00Z',
};

/** Routes that make every page of the SPA render with realistic data. */
export const allRoutes: Record<string, unknown> = {
  // The role the console trusts for the administration area (ADR-0041 §1).
  'GET /me': { id: ME, role: 'admin' },
  'GET /me/usage': { used_bytes: 96 * MB, quota_bytes: 100 * MB, level: 'critical' },
  'GET /me/devices': {
    items: [
      {
        id: 'd1',
        name: 'Laptop',
        platform: 'macos',
        app_version: '1.0.0',
        created_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-02-01T10:00:00Z',
      },
      {
        id: 'd2',
        name: 'Old PC',
        platform: 'windows',
        created_at: '2025-01-01T00:00:00Z',
        revoked_at: '2025-06-01T00:00:00Z',
      },
    ],
  },
  'GET /vaults': {
    items: [vault(V_SHARED, 'shared', 'Notes'), vault(V_PRIVATE, 'private', 'Secrets')],
    mounts: [],
  },
  'GET /shares': (route: Route) => ({
    items:
      new URL(route.request().url()).searchParams.get('scope') === 'owned'
        ? [
            {
              ...shareCommon,
              id: 's-own',
              display_name: 'Project X',
              owner_id: ME,
              owner_name: 'Alice',
              grants: [
                {
                  grantee_type: 'user',
                  grantee_id: BOB,
                  grantee_name: 'Bob',
                  permission: 'editor',
                  status: 'accepted',
                },
              ],
            },
          ]
        : [
            {
              ...shareCommon,
              id: 's-inv',
              display_name: 'Budget',
              owner_id: BOB,
              owner_name: 'Bob',
              my_permission: 'editor',
              my_status: 'pending',
            },
          ],
  }),
  'GET /directory/users': { items: [] },
  'GET /directory/groups': { items: [] },
  'GET /admin/storage/overview': {
    default_quota_bytes: 100 * MB,
    total_used_bytes: 300 * MB,
    user_count: 3,
    users_over_warn: 1,
    users_over_critical: 1,
    top_consumers: [
      { user_id: 'u1', username: 'alice', used_bytes: 96 * MB, quota_bytes: 100 * MB },
      { user_id: 'u2', username: 'bob', used_bytes: 10 * MB, quota_bytes: -1 },
    ],
    trend: [
      { day: '2026-03-01', total_bytes: 100 * MB },
      { day: '2026-03-02', total_bytes: 300 * MB },
    ],
  },
  'GET /admin/settings/storage': {
    default_quota_bytes: 5 * 1024 * MB,
    warn_percent: 80,
    critical_percent: 95,
    history_retention_days: 30,
    history_daily_retention_days: 90,
    max_file_size_bytes: 100 * MB,
  },
  'GET /admin/users': { items: [adminUser(), adminUser('u2', 'bob')], total: 2 },
  [`GET /admin/users/${U1}`]: adminUser(),
  [`GET /admin/users/${U1}/devices`]: [
    { id: 'd1', name: 'Laptop', platform: 'linux', created_at: '2026-01-15T10:00:00Z' },
  ],
  [`GET /admin/users/${U1}/sessions`]: [
    {
      id: 's1',
      ip_address: '10.0.0.1',
      started: '2026-01-15T10:00:00Z',
      last_access: '2026-01-15T11:00:00Z',
      clients: ['memobrain-desktop'],
    },
  ],
  [`GET /admin/users/${U1}/vaults`]: [
    {
      id: 'v1',
      name: 'Notes',
      kind: 'private',
      total_bytes: 2048,
      file_count: 3,
      created_at: '2026-01-15T10:00:00Z',
    },
  ],
  [`GET /admin/users/${U1}/config/effective`]: {
    version: 4,
    config: { editor: { fontSize: 14 } },
    locked_keys: ['editor.fontSize'],
  },
  'GET /admin/groups': { items: [group] },
  [`GET /admin/groups/${G}`]: group,
  [`GET /admin/groups/${G}/members`]: {
    items: [
      {
        user_id: U1,
        username: 'alice',
        email: 'alice@example.com',
        display_name: 'Alice',
        member_role: 'member',
      },
    ],
  },
  [`GET /admin/groups/${G}/config-profiles`]: [],
  'GET /admin/config-profiles': [{ ...profile, is_global: true, id: 'g', name: 'Global' }, profile],
  [`GET /admin/config-profiles/${P}`]: profile,
  [`GET /admin/config-profiles/${P}/versions`]: {
    items: [{ version: 1, name: 'Base', is_global: false, updated_at: '2026-01-01T10:00:00Z' }],
  },
  [`GET /admin/config-profiles/${P}/versions/1`]: {
    version: 1,
    name: 'Base',
    is_global: false,
    config: {},
    locked_keys: [],
    updated_at: '2026-01-01T10:00:00Z',
  },
  'GET /admin/audit-log': {
    items: [
      {
        id: 1,
        at: '2026-03-01T10:00:00Z',
        actor_id: U1,
        actor_name: 'alice',
        action: 'user.suspend',
        target_type: 'user',
        target_id: 'u-9',
        ip: '10.0.0.1',
        details: { reason: 'test' },
      },
    ],
  },
};
