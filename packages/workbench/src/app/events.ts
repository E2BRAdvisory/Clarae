// Events of the Go backend (Go → TypeScript). Names and payload types are generated from the Go
// registry (events.gen.ts, `task gen`, ADR-0045 §5): this module re-exports them under the names the
// UI uses and adds what only the UI knows (local `rename` changes). Never write an event name by hand:
// use `Events.<key>` (ESLint refuses the literals).
import type { Entry } from './api';
import type {
  ChangeType,
  EventPayloads,
  FileChange as CoreFileChange,
  FileChangedPayload as CoreFileChangedPayload,
} from './events.gen';

export { Events } from './events.gen';
export type {
  EventName,
  EventPayload,
  EventPayloads,
  IndexProgressPayload,
  OpenRequestPayload,
  ImportProgressPayload,
  ImportDonePayload,
} from './events.gen';

/**
 * What happened to one path (internal/app/changes.go). The core classifies against the index as it
 * was before the batch, so `create` means "a file the vault did not have". `rename` is never sent
 * by the core (the watcher sees a deletion and a creation) but may be used by local producers.
 */
export type FileChangeType = ChangeType | 'rename';

export interface FileChange extends Omit<CoreFileChange, 'type' | 'entry'> {
  type: FileChangeType;
  /** The previous path of a `rename`. */
  from?: string;
  /** The file or folder as it is now (absent for `delete`, and when it could not be read). */
  entry?: Entry;
}

/** `vault:file-changed`, with the UI's own change types. */
export interface FileChangedPayload extends Omit<CoreFileChangedPayload, 'changes'> {
  /** The same paths, classified. Older cores omit it: consumers must then assume anything changed. */
  changes?: FileChange[];
}

export type SyncConflictPayload = EventPayloads['sync:conflict'];

/** Why a private vault was locked: by the user, by the idle timeout, or found without its key by a sync cycle. */
export type VaultLockReason = EventPayloads['vault:locked']['reason'];

/**
 * `vault:locked`, sent once the key is gone (the core pushes pending changes first). `pending`
 * counts the files that still differ from the server (they leave at the next unlock), -1 when
 * unknown; a host may drop a clear-text copy only when it is 0.
 */
export type VaultLockedPayload = EventPayloads['vault:locked'];

export type MountRevokedPayload = EventPayloads['mount:revoked'];

/**
 * `vault:cloud-deleted`: the cloud vault of a linked folder was deleted from the console or from
 * another device. The core disconnected the folder, which keeps its files, as after a delete made
 * here (internal/sync, cloudVaultDeleted); a `sync:status` with the reason follows.
 */
export type VaultCloudDeletedPayload = EventPayloads['vault:cloud-deleted'];
