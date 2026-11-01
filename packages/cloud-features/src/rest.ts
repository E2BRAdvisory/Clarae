// The console's CloudPort: the REST API through the generated client (ADR-0037 §2).
import { unwrap, type MemobrainClient } from '@memobrain/api-client';
import type { CloudCapabilities, CloudPort, CloudVault } from './port';

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
}
