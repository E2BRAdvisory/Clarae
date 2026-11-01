// Event names emitted by the Go backend (mirror of internal/app/events.go).
import type { Entry } from './api';

export const Events = {
  vaultFileChanged: 'vault:file-changed',
  indexProgress: 'index:progress',
  syncStatus: 'sync:status',
  syncConflict: 'sync:conflict',
  vaultLocked: 'vault:locked',
  authState: 'auth:state',
  configUpdated: 'config:updated',
  sharesChanged: 'shares:changed',
  mountsChanged: 'mounts:changed',
  mountRevoked: 'mount:revoked',
  openRequest: 'app:open-request',
  /** Desktop: the window is closing; flush, then call runtime Quit (emitted by apps/desktop/main.go). */
  beforeClose: 'app:before-close',
} as const;

/**
 * What happened to one path (internal/app/changes.go). The core classifies against the index as it
 * was before the batch, so `create` means "a file the vault did not have". `rename` is never sent
 * by the core (the watcher sees a deletion and a creation) but may be used by local producers.
 */
export type FileChangeType = 'create' | 'modify' | 'delete' | 'rename';

export interface FileChange {
  type: FileChangeType;
  path: string;
  /** The previous path of a `rename`. */
  from?: string;
  /** The file or folder as it is now (absent for `delete`, and when it could not be read). */
  entry?: Entry;
}

export interface FileChangedPayload {
  vaultId: string;
  /** Every path of the batch. */
  paths: string[];
  /** The same paths, classified. Older cores omit it: consumers must then assume anything changed. */
  changes?: FileChange[];
}

export interface IndexProgressPayload {
  vaultId: string;
  done: number;
  total: number;
  path: string;
  finished: boolean;
}

export interface SyncConflictPayload {
  vaultId: string;
}

/** Why a private vault was locked: by the user, by the idle timeout, or found without its key by a sync cycle. */
export type VaultLockReason = 'manual' | 'idle' | 'sync';

/**
 * `vault:locked`, sent once the key is gone (the core pushes pending changes first). `pending`
 * counts the files that still differ from the server (they leave at the next unlock), -1 when
 * unknown; a host may drop a clear-text copy only when it is 0.
 */
export interface VaultLockedPayload {
  vaultId: string;
  reason: VaultLockReason;
  pending: number;
  conflicts: number;
}

export interface OpenRequestPayload {
  vault: string;
  file: string;
}

export interface MountRevokedPayload {
  vaultId: string;
  shareId: string;
  name: string;
}
