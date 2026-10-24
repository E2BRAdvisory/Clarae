// Event names emitted by the Go backend (mirror of internal/app/events.go).
export const Events = {
  vaultFileChanged: 'vault:file-changed',
  indexProgress: 'index:progress',
  syncStatus: 'sync:status',
  syncConflict: 'sync:conflict',
  vaultLocked: 'vault:locked',
  authState: 'auth:state',
  configUpdated: 'config:updated',
  openRequest: 'app:open-request',
} as const;

export interface FileChangedPayload {
  vaultId: string;
  paths: string[];
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

export interface VaultLockedPayload {
  vaultId: string;
}

export interface OpenRequestPayload {
  vault: string;
  file: string;
}
