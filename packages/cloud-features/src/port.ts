// The one interface the cloud management UI depends on (ADR-0037 §2). Two adapters implement it:
// RestCloudPort (the web console, REST through @memobrain/api-client) and CoreCloudPort (desktop
// and web workbench, the Go bindings; it lives in @memobrain/workbench, next to the bindings it
// calls). The data types are the ones generated from api/openapi.yaml.
import type { Schemas } from '@memobrain/api-client';

/** A cloud vault as the API describes it; `deleted_at` is set on a soft-deleted one. */
export type CloudVault = Schemas['Vault'];
export type VaultKind = Schemas['VaultKind'];
/**
 * A device of the account. `current` is set by a port that knows which device it runs on (the core
 * knows its own registration); the console passes the id of this browser to the component instead.
 */
export type CloudDevice = Schemas['Device'] & { current?: boolean };
/** Storage used by the account, with the level the server computed from its thresholds. */
export type CloudUsage = Schemas['Usage'];
export type UsageLevel = CloudUsage['level'];
/** A share; `my_permission` is unset for the owner of the vault, set for a manager or a recipient. */
export type Share = Schemas['Share'];
/**
 * A page of shares (GET /shares): `next_cursor`, absent on the last page, asks for the next one. A
 * page may hold fewer shares than the page size, even none, and still have a next one.
 */
export type SharePage = Schemas['SharePage'];
export type Grant = Schemas['Grant'];
export type SharePermission = Schemas['SharePermission'];
export type GrantStatus = Schemas['GrantStatus'];
export type PrincipalType = Grant['principal_type'];
export type GroupMembership = Schemas['GroupMembership'];

/**
 * A mount: a share the user accepted, as GET /shared-with-me describes it (accepted shares are the
 * mounts, on every host). `scope` is the sync parameter of the core and is not part of the model. A
 * port that keeps copies on this device (`capabilities.keepsLocalCopy`, the core) adds `local`, and
 * also lists the copies whose share is gone (revoked, expired) until the user decides about them.
 */
export type CloudMount = Omit<Schemas['Mount'], 'scope'> & {
  local?: MountCopy | undefined;
};

/** The copy of a mount on this device (core only). */
export interface MountCopy {
  /** Folder of the copy ("" until it is created). */
  path: string;
  /** The folder exists on this device. */
  mounted: boolean;
  /** The share is gone (revoked, expired, deleted) but the copy is still here. */
  revoked: boolean;
  /** The local id of the vault while the mount is open here ("" otherwise). */
  open_vault_id: string;
}

/** A user or group found in the directory, to share with. */
export interface DirectoryEntry {
  type: PrincipalType;
  id: string;
  /** What the list shows: display name (users) or group name. */
  name: string;
  /** A second line: the username of a user, the description of a group. */
  detail?: string | undefined;
}

/** Users of the directory (GET /directory/users) as the list shows them, by both adapters. */
export function userEntries(users: Schemas['DirectoryUser'][]): DirectoryEntry[] {
  return users.map((u) => ({
    type: 'user',
    id: u.id,
    name: u.display_name || u.username,
    detail: u.username,
  }));
}

/** Groups of the directory (GET /directory/groups) as the list shows them, by both adapters. */
export function groupEntries(groups: Schemas['DirectoryGroup'][]): DirectoryEntry[] {
  return groups.map((g) => ({ type: 'group', id: g.id, name: g.name, detail: g.description }));
}

/** A new share of a whole cloud vault (no `path_prefix`) or of one of its folders. */
export interface NewShare {
  vault_id: string;
  display_name: string;
  /** Folder share: the folder, relative to the vault root ("Projects/Alfa"). */
  path_prefix?: string | undefined;
  /** RFC 3339. */
  expires_at?: string | undefined;
  grants?: Schemas['NewGrant'][] | undefined;
}

/** A change of a share (PATCH /shares/{id}): new name, new expiry, or no expiry any more. */
export type ShareUpdate = Schemas['UpdateShare'];

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
  /**
   * The port lists the groups of the user (`listMyGroups`). The desktop and the workbench leave the
   * account's information to the console (feature registry, `account.groups`).
   */
  myGroups?: boolean;
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

  // ---- devices and usage (§2.8) ----
  /** The devices registered by the account (revoked ones included when the server lists them). */
  listDevices(): Promise<CloudDevice[]>;
  revokeDevice(id: string): Promise<void>;
  getUsage(): Promise<CloudUsage>;

  // ---- sharing (§2.6.4); never on a private vault (D-02) ----
  /**
   * A page of shares, newest first: "owned", created or managed by the user; "received",
   * invitations and accepted shares. No cursor for the first page, then the `next_cursor` of the
   * page before (useSharePages reads them).
   */
  listShares(scope: 'owned' | 'received', cursor?: string): Promise<SharePage>;
  createShare(input: NewShare): Promise<Share>;
  updateShare(id: string, change: ShareUpdate): Promise<Share>;
  /** Owner only. */
  revokeShare(id: string): Promise<void>;
  putGrant(
    shareId: string,
    type: PrincipalType,
    principalId: string,
    permission: SharePermission,
  ): Promise<void>;
  deleteGrant(shareId: string, type: PrincipalType, principalId: string): Promise<void>;
  /**
   * The mounts of the user: the accepted shares (GET /shared-with-me) and, where the port keeps
   * copies, the copies on this device whose share is gone.
   */
  listMounts(): Promise<CloudMount[]>;
  acceptInvitation(shareId: string): Promise<void>;
  declineInvitation(shareId: string): Promise<void>;
  /** Users or groups whose name matches `query` (at least two characters). */
  searchDirectory(type: PrincipalType, query: string): Promise<DirectoryEntry[]>;

  // ---- account ----
  /** The groups the user belongs to; only when `capabilities.myGroups`. */
  listMyGroups(): Promise<GroupMembership[]>;
  /** The feature flags of the effective configuration (§2.6.6), as given; see `featureOn`. */
  getFeatures(): Promise<Record<string, boolean>>;
}

/** The application codes the components explain in their own words (others show the message). */
export type KnownCode =
  'NAME_IN_USE' | 'NOT_FOUND' | 'VALIDATION_FAILED' | 'FORBIDDEN' | 'VAULT_ENCRYPTED';

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
  const text = (e instanceof Error ? e.message : String(e)).trim();
  // "CODE: detail", "code-in-kebab: detail", or "CODE (404)" when the problem had no detail.
  const m = /^([A-Za-z_-]+):/.exec(text) ?? /^([A-Z_]+) \(\d{3}\)$/.exec(text);
  return m ? (m[1] as string).toUpperCase().replace(/-/g, '_') : 'UNKNOWN';
}
