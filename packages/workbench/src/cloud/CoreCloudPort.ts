// The CloudPort of the desktop and of the web workbench (ADR-0037 §2): cloud vaults, devices, usage
// and sharing through the Go core's bindings. It lives here, not in @memobrain/cloud-features,
// because it calls the workbench's binding facade (app/api.ts); the package only defines the
// interface, so the dependency goes one way (workbench -> cloud-features). The bindings return the
// OpenAPI types the components use (ADR-0045 §6, asserted by bindingTypes.test.ts), so this adapter
// passes them through: what is left is what only the core does (a vault is created by connecting a
// folder, a delete keeps the local copy, accepting prepares the mount, the flags of the cached
// configuration).
import {
  CloudError,
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
} from '@memobrain/cloud-features/port';
import { api } from '../app/api';

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

  listVaults(): Promise<CloudVault[]> {
    return this.sync.listCloudVaults();
  }

  listDeletedVaults(): Promise<CloudVault[]> {
    return this.sync.listDeletedCloudVaults();
  }

  createVault(): Promise<CloudVault> {
    return Promise.reject(
      new CloudError('UNSUPPORTED', 'a cloud vault is created by connecting a folder to it'),
    );
  }

  renameVault(id: string, name: string): Promise<CloudVault> {
    return this.sync.renameCloudVault(id, name);
  }

  deleteVault(id: string): Promise<void> {
    return this.sync.deleteCloudVault(id);
  }

  restoreVault(id: string): Promise<CloudVault> {
    return this.sync.restoreCloudVault(id);
  }

  listDevices(): Promise<CloudDevice[]> {
    return this.sync.devices();
  }

  revokeDevice(id: string): Promise<void> {
    return this.sync.revokeDevice(id);
  }

  getUsage(): Promise<CloudUsage> {
    return this.sync.usage();
  }

  listShares(scope: 'owned' | 'received', cursor?: string): Promise<SharePage> {
    return this.sharing.list(scope, cursor ?? '');
  }

  /** A share of a cloud vault or of one of its folders, without a local copy (CreateCloudShare). */
  createShare(input: NewShare): Promise<Share> {
    return this.sharing.createCloud(
      input.vault_id,
      input.path_prefix ?? '',
      input.display_name,
      input.grants ?? [],
      input.expires_at ?? '',
    );
  }

  updateShare(id: string, change: ShareUpdate): Promise<Share> {
    return this.sharing.update(id, change);
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
    if (type === 'user') return userEntries(await this.sharing.searchUsers(query));
    return groupEntries(await this.sharing.searchGroups(query));
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
