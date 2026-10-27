// react-query hooks for the administration console (all endpoints below /admin).
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { ApiError, unwrap, type MemobrainClient, type Schemas } from '@memobrain/api-client';
import { useApi } from './context';

export type AdminUser = Schemas['AdminUser'];
export type AdminVault = Schemas['AdminVault'];
export type AdminGroup = Schemas['AdminGroup'];
export type GroupMember = Schemas['GroupMember'];
export type ConfigProfile = Schemas['ConfigProfile'];
export type ConfigProfileInput = Schemas['ConfigProfileInput'];
export type ProfileVersion = Schemas['ProfileVersion'];
export type ProfileAssignment = Schemas['ProfileAssignment'];
export type StorageSettings = Schemas['StorageSettings'];
export type AuditEntry = Schemas['AuditEntry'];
export type Role = Schemas['Role'];

export interface UserFilters {
  q: string;
  status: string;
  role: string;
  group: string;
  sort: string;
  limit: number;
  offset: number;
}

export interface AuditFilters {
  actor: string;
  action: string;
  target: string;
  from: string;
  to: string;
}

/** Drops empty values so optional query parameters are omitted instead of sent blank. */
function compact<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o) as [string, string | number | undefined][]) {
    if (v !== '' && v !== undefined) (out as Record<string, string | number>)[k] = v;
  }
  return out;
}

export const adminKeys = {
  all: ['admin'] as const,
  overview: ['admin', 'overview'] as const,
  settings: ['admin', 'settings'] as const,
  users: ['admin', 'users'] as const,
  userList: (f: UserFilters) => ['admin', 'users', 'list', f] as const,
  user: (id: string) => ['admin', 'users', 'one', id] as const,
  userPart: (id: string, part: 'vaults' | 'devices' | 'sessions' | 'config') =>
    ['admin', 'users', 'one', id, part] as const,
  groups: ['admin', 'groups'] as const,
  group: (id: string) => ['admin', 'groups', 'one', id] as const,
  groupMembers: (id: string) => ['admin', 'groups', 'one', id, 'members'] as const,
  groupProfiles: (id: string) => ['admin', 'groups', 'one', id, 'profiles'] as const,
  profiles: ['admin', 'profiles'] as const,
  profile: (id: string) => ['admin', 'profiles', 'one', id] as const,
  versions: (id: string) => ['admin', 'profiles', 'one', id, 'versions'] as const,
  audit: (f: AuditFilters) => ['admin', 'audit', f] as const,
};

/* ---- Storage ---------------------------------------------------------------- */

export function useStorageOverview() {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.overview,
    queryFn: () => unwrap(api.GET('/admin/storage/overview')),
  });
}

export function useStorageSettings() {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.settings,
    queryFn: () => unwrap(api.GET('/admin/settings/storage')),
  });
}

export function usePutStorageSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StorageSettings) => unwrap(api.PUT('/admin/settings/storage', { body })),
    onSuccess: (data) => {
      qc.setQueryData(adminKeys.settings, data);
      // The default quota changes every effective quota and the dashboard.
      return Promise.all([
        qc.invalidateQueries({ queryKey: adminKeys.overview }),
        qc.invalidateQueries({ queryKey: adminKeys.users }),
      ]);
    },
  });
}

export function useBulkQuota() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { userIds: string[]; quotaBytes: number | null }) =>
      unwrap(
        api.POST('/admin/storage/bulk-quota', {
          body: { user_ids: v.userIds, quota_bytes: v.quotaBytes },
        }),
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: adminKeys.users }),
        qc.invalidateQueries({ queryKey: adminKeys.overview }),
      ]),
  });
}

/* ---- Users ------------------------------------------------------------------- */

export function useAdminUsers(f: UserFilters, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.userList(f),
    enabled,
    placeholderData: (prev) => prev,
    queryFn: () => unwrap(api.GET('/admin/users', { params: { query: compact(f) } })),
  });
}

export function useAdminUser(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.user(id),
    queryFn: () => unwrap(api.GET('/admin/users/{userId}', { params: { path: { userId: id } } })),
  });
}

/** Sub-resources of a user (metadata only: vaults never expose content to administrators). */
export function useUserVaults(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.userPart(id, 'vaults'),
    queryFn: () =>
      unwrap(api.GET('/admin/users/{userId}/vaults', { params: { path: { userId: id } } })),
  });
}

export function useUserDevices(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.userPart(id, 'devices'),
    queryFn: () =>
      unwrap(api.GET('/admin/users/{userId}/devices', { params: { path: { userId: id } } })),
  });
}

export function useUserSessions(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.userPart(id, 'sessions'),
    queryFn: () =>
      unwrap(api.GET('/admin/users/{userId}/sessions', { params: { path: { userId: id } } })),
  });
}

export function useEffectiveConfig(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.userPart(id, 'config'),
    queryFn: () =>
      unwrap(
        api.GET('/admin/users/{userId}/config/effective', { params: { path: { userId: id } } }),
      ),
  });
}

function invalidateUser(qc: QueryClient, id: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: adminKeys.user(id) }),
    qc.invalidateQueries({ queryKey: adminKeys.users }),
    qc.invalidateQueries({ queryKey: adminKeys.overview }),
  ]);
}

export function useCreateUser() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['CreateAdminUser']) => unwrap(api.POST('/admin/users', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

export function useUpdateUser(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas['UpdateAdminUser']) =>
      unwrap(api.PATCH('/admin/users/{userId}', { params: { path: { userId: id } }, body })),
    onSuccess: () => invalidateUser(qc, id),
  });
}

export function useUserAction(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'suspend' | 'activate') => {
      const params = { params: { path: { userId: id } } };
      return unwrap(
        action === 'suspend'
          ? api.POST('/admin/users/{userId}:suspend', params)
          : api.POST('/admin/users/{userId}:activate', params),
      );
    },
    onSuccess: () => invalidateUser(qc, id),
  });
}

export function useResetPassword(id: string) {
  const api = useApi();
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/admin/users/{userId}:reset-password', { params: { path: { userId: id } } }),
      ),
  });
}

export function useSetRole(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: Role) =>
      unwrap(
        api.PUT('/admin/users/{userId}/role', { params: { path: { userId: id } }, body: { role } }),
      ),
    onSuccess: () => invalidateUser(qc, id),
  });
}

/** `null` = the global default, `-1` = unlimited. */
export function useSetQuota(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (quotaBytes: number | null) =>
      unwrap(
        api.PUT('/admin/users/{userId}/quota', {
          params: { path: { userId: id } },
          body: quotaBytes === null ? {} : { quota_bytes: quotaBytes },
        }),
      ),
    onSuccess: () => invalidateUser(qc, id),
  });
}

export function useDeleteUser() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/admin/users/{userId}', { params: { path: { userId: id } } })),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: adminKeys.users }),
        qc.invalidateQueries({ queryKey: adminKeys.groups }),
        qc.invalidateQueries({ queryKey: adminKeys.overview }),
      ]),
  });
}

/* ---- Groups -------------------------------------------------------------------- */

export function useAdminGroups() {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.groups,
    queryFn: () => unwrap(api.GET('/admin/groups')),
  });
}

export function useAdminGroup(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.group(id),
    queryFn: () =>
      unwrap(api.GET('/admin/groups/{groupId}', { params: { path: { groupId: id } } })),
  });
}

export function useSaveGroup() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Schemas['GroupInput'] }) =>
      id
        ? unwrap(api.PATCH('/admin/groups/{groupId}', { params: { path: { groupId: id } }, body }))
        : unwrap(api.POST('/admin/groups', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.groups }),
  });
}

export function useDeleteGroup() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/admin/groups/{groupId}', { params: { path: { groupId: id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.groups }),
  });
}

export function useGroupMembers(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.groupMembers(id),
    queryFn: () =>
      unwrap(api.GET('/admin/groups/{groupId}/members', { params: { path: { groupId: id } } })),
  });
}

/** Adds a member or changes the role of an existing one (same endpoint). */
export function useSetMemberRole(groupId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: GroupMember['member_role'] }) =>
      unwrap(
        api.PUT('/admin/groups/{groupId}/members/{userId}', {
          params: { path: { groupId, userId } },
          body: { member_role: role },
        }),
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: adminKeys.groupMembers(groupId) }),
        qc.invalidateQueries({ queryKey: adminKeys.groups }),
        qc.invalidateQueries({ queryKey: adminKeys.group(groupId) }),
      ]),
  });
}

export function useRemoveMember(groupId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.DELETE('/admin/groups/{groupId}/members/{userId}', {
          params: { path: { groupId, userId } },
        }),
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: adminKeys.groupMembers(groupId) }),
        qc.invalidateQueries({ queryKey: adminKeys.groups }),
        qc.invalidateQueries({ queryKey: adminKeys.group(groupId) }),
      ]),
  });
}

export function useGroupProfiles(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.groupProfiles(id),
    queryFn: () =>
      unwrap(
        api.GET('/admin/groups/{groupId}/config-profiles', { params: { path: { groupId: id } } }),
      ),
  });
}

export function usePutGroupProfiles(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: ProfileAssignment[]) =>
      unwrap(
        api.PUT('/admin/groups/{groupId}/config-profiles', {
          params: { path: { groupId: id } },
          body: { items },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.groupProfiles(id) }),
  });
}

/* ---- Configuration profiles ---------------------------------------------------- */

export function useProfiles() {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.profiles,
    queryFn: () => unwrap(api.GET('/admin/config-profiles')),
  });
}

export function useProfile(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.profile(id),
    enabled: id !== '',
    queryFn: () =>
      unwrap(
        api.GET('/admin/config-profiles/{profileId}', { params: { path: { profileId: id } } }),
      ),
  });
}

export function useProfileVersions(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: adminKeys.versions(id),
    queryFn: () =>
      unwrap(
        api.GET('/admin/config-profiles/{profileId}/versions', {
          params: { path: { profileId: id } },
        }),
      ),
  });
}

export function useSaveProfile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ConfigProfileInput }) =>
      id
        ? unwrap(
            api.PUT('/admin/config-profiles/{profileId}', {
              params: { path: { profileId: id } },
              body,
            }),
          )
        : unwrap(api.POST('/admin/config-profiles', { body })),
    // Saving a global profile demotes the previous one, so the whole subtree is refreshed.
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.profiles }),
  });
}

export function useRestoreVersion(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) =>
      unwrap(
        api.POST('/admin/config-profiles/{profileId}/versions/{version}:restore', {
          params: { path: { profileId: id, version } },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.profiles }),
  });
}

export function useDeleteProfile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE('/admin/config-profiles/{profileId}', { params: { path: { profileId: id } } }),
      ),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: adminKeys.profiles }),
        qc.invalidateQueries({ queryKey: ['admin', 'groups'] }),
      ]),
  });
}

/* ---- Audit log ------------------------------------------------------------------ */

export const AUDIT_PAGE_SIZE = 100;

/** Newest first, cursor pagination: `fetchNextPage` loads the next block. */
export function useAuditLog(f: AuditFilters) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: adminKeys.audit(f),
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/admin/audit-log', {
          params: { query: compact({ ...f, limit: AUDIT_PAGE_SIZE, cursor: pageParam }) },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
}

/** Fetches the CSV with the bearer token of the client (a plain link could not send it). */
export async function fetchAuditCsv(
  api: MemobrainClient,
  f: AuditFilters,
  signal?: AbortSignal,
): Promise<Blob> {
  const { data, error, response } = await api.GET('/admin/audit-log.csv', {
    params: { query: compact(f) },
    parseAs: 'blob',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const problem = error as Schemas['Problem'] | undefined;
    throw new ApiError(response.status, problem, `${response.status} ${response.statusText}`);
  }
  return data as unknown as Blob;
}
