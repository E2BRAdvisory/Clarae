// The one interface the cloud management UI depends on (ADR-0037 §2). Two adapters implement it:
// RestCloudPort (the web console, REST through @memobrain/api-client) and CoreCloudPort (desktop
// and web workbench, the Go bindings; it lives in @memobrain/workbench, next to the bindings it
// calls). The data types are the ones generated from api/openapi.yaml.
import type { Schemas } from '@memobrain/api-client';

/** A cloud vault as the API describes it; `deleted_at` is set on a soft-deleted one. */
export type CloudVault = Schemas['Vault'];
export type VaultKind = Schemas['VaultKind'];

/** What the host can do, so the components show only that. */
export interface CloudCapabilities {
  /**
   * The port creates a shared vault by itself (`createVault`). The desktop cannot: a cloud vault is
   * created by connecting a folder to it, so its "New vault" opens the host's own flow.
   */
  createShared: boolean;
  /**
   * A private vault can be created from this host. Its keys are made by the Go core (envelopes,
   * recovery key), so creation is always the host's callback, never the port (D-02).
   */
  createPrivate: boolean;
  /** Deleting leaves the local copy of this device in place, disconnected (desktop, workbench). */
  keepsLocalCopy: boolean;
  /** Days a deleted vault stays restorable, when the host knows them (the API does not say). */
  deletedRetentionDays?: number;
}

export interface CloudPort {
  /** Tells the caches of two ports apart (e.g. "rest", "core"). */
  readonly id: string;
  readonly capabilities: CloudCapabilities;
  /** The caller's own vaults (not the mounts of shares, not the deleted ones). */
  listVaults(): Promise<CloudVault[]>;
  /** The caller's soft-deleted vaults that can still be restored (`deleted_at` set). */
  listDeletedVaults(): Promise<CloudVault[]>;
  /** Creates a shared vault; only when `capabilities.createShared`. */
  createVault(name: string, kind: 'shared'): Promise<CloudVault>;
  renameVault(id: string, name: string): Promise<CloudVault>;
  /** Soft delete: restorable within the retention period. */
  deleteVault(id: string): Promise<void>;
  restoreVault(id: string): Promise<CloudVault>;
}

/** The application codes the components explain in their own words (others show the message). */
export type KnownCode = 'NAME_IN_USE' | 'NOT_FOUND' | 'VALIDATION_FAILED' | 'FORBIDDEN';

/** An error of a port: the API's application code when there is one, and a message. */
export class CloudError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

/**
 * The application code of an error from either adapter: an ApiError (`code`), or a message of the
 * Go core, which renders an API problem as "CODE: detail" (and its mock as "code-in-kebab: …").
 */
export function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code;
  const text = e instanceof Error ? e.message : String(e);
  const m = /^([A-Za-z_-]+):/.exec(text.trim());
  return m ? (m[1] as string).toUpperCase().replace(/-/g, '_') : 'UNKNOWN';
}
