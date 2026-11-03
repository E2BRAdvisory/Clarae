// The console's CloudPort: the REST API through the generated client (ADR-0037 §2).
import { unwrap, type MemobrainClient } from '@memobrain/api-client';
import { featuresOf } from './featureFlags';
import {
  groupEntries,
  userEntries,
  type CloudCapabilities,
  type CloudDevice,
  type CloudPort,
  type CloudUsage,
  type CloudVault,
  type DirectoryEntry,
  type GroupMembership,
  type NewShare,
  type PrincipalType,
  type Share,
  type SharePage,
  type SharePermission,
  type ShareUpdate,
} from './port';

export interface RestCloudPortOptions {
  /** Private vaults are created in the browser workbench, when the administrator allows it. */
  createPrivate?: boolean;
  deletedRetentionDays?: number;
}

/** CloudPort over the REST API (console). Errors are ApiError, with the API's `code`. */
export class RestCloudPort implements CloudPort {
  readonly id = 'rest';
  readonly capabilities: CloudCapabilities;

  constructor(
    private readonly api: MemobrainClient,
    options: RestCloudPortOptions = {},
  ) {
    this.capabilities = {
      createShared: true,
      createPrivate: options.createPrivate ?? false,
      keepsLocalCopy: false,
      myGroups: true,
      ...(options.deletedRetentionDays !== undefined
        ? { deletedRetentionDays: options.deletedRetentionDays }
        : {}),
    };
  }

  async listVaults(): Promise<CloudVault[]> {
    return (await unwrap(this.api.GET('/vaults'))).items;
  }

  async listDeletedVaults(): Promise<CloudVault[]> {
    const list = await unwrap(
      this.api.GET('/vaults', { params: { query: { include_deleted: true } } }),
    );
    return list.items.filter((v) => Boolean(v.deleted_at));
  }

  createVault(name: string, kind: 'shared'): Promise<CloudVault> {
    return unwrap(
      this.api.POST('/vaults', {
        params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
        body: { name, kind },
      }),
    );
  }

  renameVault(id: string, name: string): Promise<CloudVault> {
    return unwrap(
      this.api.PATCH('/vaults/{vaultId}', { params: { path: { vaultId: id } }, body: { name } }),
    );
  }

  async deleteVault(id: string): Promise<void> {
    await unwrap(this.api.DELETE('/vaults/{vaultId}', { params: { path: { vaultId: id } } }));
  }

  restoreVault(id: string): Promise<CloudVault> {
    return unwrap(
      this.api.POST('/vaults/{vaultId}:restore', { params: { path: { vaultId: id } } }),
    );
  }

  async listDevices(): Promise<CloudDevice[]> {
    return (await unwrap(this.api.GET('/me/devices'))).items;
  }

  async revokeDevice(id: string): Promise<void> {
    await unwrap(this.api.DELETE('/me/devices/{deviceId}', { params: { path: { deviceId: id } } }));
  }

  getUsage(): Promise<CloudUsage> {
    return unwrap(this.api.GET('/me/usage'));
  }

  listShares(scope: 'owned' | 'received', cursor?: string): Promise<SharePage> {
    return unwrap(
      this.api.GET('/shares', { params: { query: { scope, ...(cursor ? { cursor } : {}) } } }),
    );
  }

  createShare(input: NewShare): Promise<Share> {
    const { path_prefix, expires_at, grants, ...rest } = input;
    return unwrap(
      this.api.POST('/shares', {
        body: {
          ...rest,
          resource_type: path_prefix ? 'folder' : 'vault',
          ...(path_prefix ? { path_prefix } : {}),
          ...(expires_at ? { expires_at } : {}),
          ...(grants?.length ? { grants } : {}),
        },
      }),
    );
  }

  updateShare(id: string, change: ShareUpdate): Promise<Share> {
    return unwrap(
      this.api.PATCH('/shares/{shareId}', { params: { path: { shareId: id } }, body: change }),
    );
  }

  async revokeShare(id: string): Promise<void> {
    await unwrap(this.api.DELETE('/shares/{shareId}', { params: { path: { shareId: id } } }));
  }

  async putGrant(
    shareId: string,
    principalType: PrincipalType,
    principalId: string,
    permission: SharePermission,
  ): Promise<void> {
    await unwrap(
      this.api.PUT('/shares/{shareId}/grants/{principalType}/{principalId}', {
        params: { path: { shareId, principalType, principalId } },
        body: { permission },
      }),
    );
  }

  async deleteGrant(
    shareId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<void> {
    await unwrap(
      this.api.DELETE('/shares/{shareId}/grants/{principalType}/{principalId}', {
        params: { path: { shareId, principalType, principalId } },
      }),
    );
  }

  async acceptInvitation(shareId: string): Promise<void> {
    await unwrap(this.api.POST('/shares/{shareId}:accept', { params: { path: { shareId } } }));
  }

  async declineInvitation(shareId: string): Promise<void> {
    await unwrap(this.api.POST('/shares/{shareId}:decline', { params: { path: { shareId } } }));
  }

  async searchDirectory(type: PrincipalType, q: string): Promise<DirectoryEntry[]> {
    if (type === 'user')
      return userEntries(
        await unwrap(this.api.GET('/directory/users', { params: { query: { q } } })),
      );
    return groupEntries(
      await unwrap(this.api.GET('/directory/groups', { params: { query: { q } } })),
    );
  }

  listMyGroups(): Promise<GroupMembership[]> {
    return unwrap(this.api.GET('/me/groups'));
  }

  async getFeatures(): Promise<Record<string, boolean>> {
    return featuresOf((await unwrap(this.api.GET('/config/effective'))).config);
  }
}
