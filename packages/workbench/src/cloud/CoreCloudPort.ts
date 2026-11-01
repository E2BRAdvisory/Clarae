// The CloudPort of the desktop and of the web workbench (ADR-0037 §2): the cloud vault lifecycle
// through the Go core's bindings. It lives here, not in @memobrain/cloud-features, because it calls
// the workbench's binding facade (app/api.ts); the package only defines the interface, so the
// dependency goes one way (workbench -> cloud-features).
import {
  CloudError,
  type CloudCapabilities,
  type CloudPort,
  type CloudVault,
} from '@memobrain/cloud-features';
import { api, type CloudVault as BindingVault } from '../app/api';

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

export class CoreCloudPort implements CloudPort {
  readonly id = 'core';
  /**
   * The core creates a cloud vault only by connecting a folder to it (the connect wizard), and a
   * delete disconnects the folders of this device linked to it, which keep their files (D-04).
   */
  readonly capabilities: CloudCapabilities = {
    createShared: false,
    createPrivate: false,
    keepsLocalCopy: true,
  };

  constructor(private readonly sync = api.sync) {}

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
}
