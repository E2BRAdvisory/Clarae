// The CloudPort of the desktop and of the web workbench (ADR-0037 §2): cloud vaults, devices, usage
// and sharing through the Go core's bindings. It lives here, not in @memobrain/cloud-features,
// because it calls the workbench's binding facade (app/api.ts); the package only defines the
// interface, so the dependency goes one way (workbench -> cloud-features). The bindings speak
// camelCase DTOs; this adapter turns them into the OpenAPI types the components use.
import {
  CloudError,
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
  type SharePermission,
  type ShareUpdate,
} from '@memobrain/cloud-features/port';
import {
  api,
  type CloudVault as BindingVault,
  type DeviceInfo,
  type DirectoryEntry as BindingDirectoryEntry,
  type ShareInfo,
  type UsageInfo,
} from '../app/api';

/** A binding DTO (camelCase, the core's CloudVault) as the API type the components use. */
export function toApiVault(v: BindingVault): CloudVault {
  return {
    id: v.id,
    owner_id: v.ownerId,
    name: v.name,
    kind: v.kind === 'private' ? 'private' : 'shared',
    last_seq: v.lastSeq,
    total_bytes: v.totalBytes,
    file_count: v.fileCount,
    created_at: v.createdAt,
    ...(v.deletedAt ? { deleted_at: v.deletedAt } : {}),
  };
}

const iso = (t: string | Date | null | undefined): string | undefined =>
  !t ? undefined : t instanceof Date ? t.toISOString() : t;

/** A device of the core (`current`: the device the core runs on). */
export function toApiDevice(d: DeviceInfo): CloudDevice {
  const seen = iso(d.lastSeenAt);
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    created_at: d.createdAt,
    current: d.current,
    ...(d.appVersion ? { app_version: d.appVersion } : {}),
    ...(seen ? { last_seen_at: seen } : {}),
    ...(d.revokedAt ? { revoked_at: d.revokedAt } : {}),
  };
}

export function toApiUsage(u: UsageInfo): CloudUsage {
  const level = (['ok', 'warning', 'critical', 'full'] as const).find((l) => l === u.level);
  return { used_bytes: u.usedBytes, quota_bytes: u.quotaBytes, level: level ?? 'ok' };
}

/** A share of the core as the API describes it (empty strings are absent fields). */
export function toApiShare(s: ShareInfo): Share {
  return {
    id: s.id,
    vault_id: s.vaultId,
    vault_name: s.vaultName,
    resource_type: s.resourceType,
    display_name: s.displayName,
    owner_id: s.ownerId,
    owner_name: s.ownerName,
    created_at: s.createdAt,
    ...(s.pathPrefix ? { path_prefix: s.pathPrefix } : {}),
    ...(s.expiresAt ? { expires_at: s.expiresAt } : {}),
    ...(s.myPermission ? { my_permission: s.myPermission } : {}),
    ...(s.myStatus ? { my_status: s.myStatus } : {}),
    // The core sends the grants to whoever may see them (owner, managers), an empty list otherwise.
    grants: s.grants.map((g) => ({
      principal_type: g.principalType,
      principal_id: g.principalId,
      principal_name: g.principalName,
      permission: g.permission,
      status: g.status,
      created_at: s.createdAt,
    })),
  };
}

/**
 * A directory entry of the core: a user's label is "Display name (username)" or the username, a
 * group's is its name.
 */
export function toDirectoryEntry(d: BindingDirectoryEntry): DirectoryEntry {
  const suffix = ` (${d.name})`;
  if (d.type === 'user' && d.label.endsWith(suffix))
    return { type: 'user', id: d.id, name: d.label.slice(0, -suffix.length), detail: d.name };
  return {
    type: d.type,
    id: d.id,
    name: d.label || d.name,
    ...(d.type === 'user' ? { detail: d.name } : {}),
  };
}

export class CoreCloudPort implements CloudPort {
  readonly id = 'core';
  /**
   * The core creates a cloud vault only by connecting a folder to it (the connect wizard), and a
   * delete disconnects the folders of this device linked to it, which keep their files (D-04). The
   * groups of the user are information of the account, which the console shows.
   */
  readonly capabilities: CloudCapabilities = {
    createShared: false,
    createPrivate: false,
    keepsLocalCopy: true,
    myGroups: false,
  };

  constructor(
    private readonly sync = api.sync,
    private readonly sharing = api.sharing,
    private readonly config = api.config,
  ) {}

  async listVaults(): Promise<CloudVault[]> {
    return (await this.sync.listCloudVaults()).map(toApiVault);
  }

  async listDeletedVaults(): Promise<CloudVault[]> {
    return (await this.sync.listDeletedCloudVaults()).map(toApiVault);
  }

  createVault(): Promise<CloudVault> {
    return Promise.reject(
      new CloudError('UNSUPPORTED', 'a cloud vault is created by connecting a folder to it'),
    );
  }

  async renameVault(id: string, name: string): Promise<CloudVault> {
    return toApiVault(await this.sync.renameCloudVault(id, name));
  }

  deleteVault(id: string): Promise<void> {
    return this.sync.deleteCloudVault(id);
  }

  async restoreVault(id: string): Promise<CloudVault> {
    return toApiVault(await this.sync.restoreCloudVault(id));
  }

  async listDevices(): Promise<CloudDevice[]> {
    return (await this.sync.devices()).map(toApiDevice);
  }

  revokeDevice(id: string): Promise<void> {
    return this.sync.revokeDevice(id);
  }

  async getUsage(): Promise<CloudUsage> {
    return toApiUsage(await this.sync.usage());
  }

  async listShares(scope: 'owned' | 'received'): Promise<Share[]> {
    return (await this.sharing.list(scope)).map(toApiShare);
  }

  async createShare(input: NewShare): Promise<Share> {
    const grants = (input.grants ?? []).map((g) => ({
      principalType: g.principal_type,
      principalId: g.principal_id,
      permission: g.permission,
    }));
    return toApiShare(
      await this.sharing.createCloud(
        input.vault_id,
        input.path_prefix ?? '',
        input.display_name,
        grants,
        input.expires_at ?? '',
      ),
    );
  }

  async updateShare(id: string, change: ShareUpdate): Promise<Share> {
    return toApiShare(
      await this.sharing.update(
        id,
        change.display_name ?? '',
        change.expires_at ?? '',
        change.clear_expiry ?? false,
      ),
    );
  }

  revokeShare(id: string): Promise<void> {
    return this.sharing.revoke(id);
  }

  async putGrant(
    shareId: string,
    type: PrincipalType,
    principalId: string,
    permission: SharePermission,
  ): Promise<void> {
    await this.sharing.setGrant(shareId, type, principalId, permission);
  }

  deleteGrant(shareId: string, type: PrincipalType, principalId: string): Promise<void> {
    return this.sharing.removeGrant(shareId, type, principalId);
  }

  /** Accepting also prepares the folder of the mount on this device (the core's AcceptShare). */
  async acceptInvitation(shareId: string): Promise<void> {
    await this.sharing.accept(shareId);
  }

  declineInvitation(shareId: string): Promise<void> {
    return this.sharing.decline(shareId);
  }

  async searchDirectory(type: PrincipalType, query: string): Promise<DirectoryEntry[]> {
    return (await this.sharing.directory(query))
      .filter((d) => d.type === type)
      .map(toDirectoryEntry);
  }

  listMyGroups(): Promise<GroupMembership[]> {
    return Promise.reject(
      new CloudError('UNSUPPORTED', 'the groups of the account are shown by the console'),
    );
  }

  /** The flags of the configuration in force, with the product defaults (cached when offline). */
  async getFeatures(): Promise<Record<string, boolean>> {
    return (await this.config.effective()).features;
  }
}
