// Thin typed facade over the generated Wails bindings (wailsjs/, do not edit)
// so the rest of the frontend imports one module and tests can mock it.
// Model types are exposed as plain data shapes (without the generated
// `convertValues` helper) so literals and mocks type-check structurally.
import * as VaultAPI from '../../wailsjs/go/app/VaultAPI';
import * as SearchAPI from '../../wailsjs/go/app/SearchAPI';
import * as SettingsAPI from '../../wailsjs/go/app/SettingsAPI';
import * as AuthAPI from '../../wailsjs/go/app/AuthAPI';
import * as LinksAPI from '../../wailsjs/go/app/LinksAPI';
import * as TagsAPI from '../../wailsjs/go/app/TagsAPI';
import * as PropertiesAPI from '../../wailsjs/go/app/PropertiesAPI';
import * as SyncAPI from '../../wailsjs/go/app/SyncAPI';
import * as VaultCryptoAPI from '../../wailsjs/go/app/VaultCryptoAPI';
import * as DrawingAPI from '../../wailsjs/go/app/DrawingAPI';
import * as SharingAPI from '../../wailsjs/go/app/SharingAPI';
import * as ConfigAPI from '../../wailsjs/go/app/ConfigAPI';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import type { app, auth, links, search, sync, vault } from '../../wailsjs/go/models';

type Plain<T> = Omit<T, 'convertValues'>;

export type VaultInfo = Plain<app.VaultInfo>;
export type ExportResult = Plain<app.ExportResult>;
export type NoteContent = Plain<app.NoteContent>;
export type WriteResult = Plain<app.WriteResult>;
export type AppSettings = Plain<app.AppSettings>;
export type Entry = Plain<vault.Entry>;
export type SearchHit = Plain<search.Hit>;
export type SearchResults = Omit<Plain<search.Results>, 'hits'> & { hits: SearchHit[] };
export type SearchSort = 'relevance' | 'name' | 'modified';
export type BinaryContent = Plain<app.BinaryContent>;
export type TagCount = Plain<app.TagCount>;
export type PropertyKey = Plain<app.PropertyKey>;
export type Suggestion = Plain<links.Suggestion>;
export type SuggestKind = 'notes' | 'headings' | 'blocks' | 'tags' | 'properties' | 'all';
export type NoteLink = Plain<links.Link>;
export type Mention = Plain<links.Mention>;
export interface RenameEdit {
  line: number;
  start: number;
  end: number;
  old: string;
  new: string;
}
export interface RenameFileEdit {
  path: string;
  hash: string;
  edits: RenameEdit[];
}
export interface RenamePlan {
  from: string;
  to: string;
  moves: { from: string; to: string }[];
  files: RenameFileEdit[];
}
export type SyncLinkInfo = Plain<sync.LinkInfo>;
/** A SyncLinkInfo with every field present (an unlinked vault by default). */
export function linkInfo(over: Partial<SyncLinkInfo> = {}): SyncLinkInfo {
  return {
    linked: false,
    cloudVaultId: '',
    kind: '',
    name: '',
    serverUrl: '',
    locked: false,
    paused: false,
    pollSeconds: 0,
    mount: false,
    permission: '',
    readOnly: false,
    revoked: false,
    ownerName: '',
    shareId: '',
    ...over,
  };
}
export type PermissionLevel = 'viewer' | 'editor' | 'manager';
export type ShareGrant = Omit<Plain<app.GrantInfo>, 'principalType' | 'permission' | 'status'> & {
  principalType: 'user' | 'group';
  permission: PermissionLevel;
  status: 'pending' | 'accepted' | 'declined';
};
export type ShareInfo = Omit<
  Plain<app.ShareInfo>,
  'resourceType' | 'myPermission' | 'myStatus' | 'grants'
> & {
  resourceType: 'vault' | 'folder' | 'file';
  myPermission: PermissionLevel | '';
  myStatus: 'pending' | 'accepted' | 'declined' | '';
  grants: ShareGrant[];
};
export type MountState = Omit<Plain<sync.MountState>, 'permission' | 'resourceType'> & {
  permission: PermissionLevel;
  resourceType: 'vault' | 'folder' | 'file';
};
export type DirectoryEntry = Omit<Plain<app.DirectoryEntry>, 'type'> & { type: 'user' | 'group' };
export type GrantInput = {
  principalType: 'user' | 'group';
  principalId: string;
  permission: PermissionLevel;
};
export type ConfigState = Plain<app.ConfigState>;
export type SyncLinkResult = Plain<sync.LinkResult>;
export type SyncPhase = 'idle' | 'syncing' | 'paused' | 'offline' | 'error' | 'locked';
export type SyncStatus = Omit<Plain<sync.Status>, 'phase' | 'lastSync'> & {
  phase: SyncPhase;
  lastSync: string;
};
export type SyncConflict = Omit<Plain<sync.Conflict>, 'createdAt'> & { createdAt: string };
export type RevisionInfo = Omit<Plain<sync.RevisionInfo>, 'time'> & { time: string };
export type CloudVault = Omit<Plain<app.CloudVault>, 'createdAt'> & { createdAt: string };
export type DeviceInfo = Omit<Plain<app.DeviceInfo>, 'lastSeenAt'> & { lastSeenAt: string | null };
export type UsageInfo = Plain<app.UsageInfo>;
export type ConflictTexts = Plain<app.ConflictTexts>;
export type ConflictAction = 'keep-remote' | 'keep-local' | 'keep-both' | 'merged';
export type VaultKind = 'private' | 'shared';
export type DiskEncryption = 'encrypted' | 'unencrypted' | 'unknown';
export type AuthProfile = Plain<auth.Profile>;
export type AuthState = Omit<Plain<auth.State>, 'profile'> & { profile: AuthProfile };

export const api = {
  vault: {
    listRecent: (): Promise<VaultInfo[]> => VaultAPI.ListRecent(),
    listOpen: (): Promise<VaultInfo[]> => VaultAPI.ListOpen(),
    pickFolder: (title: string): Promise<string> => VaultAPI.PickFolder(title),
    open: (path: string): Promise<VaultInfo> => VaultAPI.OpenVault(path),
    close: (vaultId: string): Promise<void> => VaultAPI.CloseVault(vaultId),
    /** Asks where to save (native dialog) and writes the vault as a ZIP file. */
    exportZip: (vaultId: string): Promise<ExportResult> => VaultAPI.ExportZip(vaultId),
    listTree: (vaultId: string): Promise<Entry[]> => VaultAPI.ListTree(vaultId),
    readNote: (vaultId: string, path: string): Promise<NoteContent> =>
      VaultAPI.ReadNote(vaultId, path),
    writeNote: (
      vaultId: string,
      path: string,
      content: string,
      expectedHash: string,
    ): Promise<WriteResult> => VaultAPI.WriteNote(vaultId, path, content, expectedHash),
    createFolder: (vaultId: string, path: string): Promise<void> =>
      VaultAPI.CreateFolder(vaultId, path),
    rename: (vaultId: string, from: string, to: string): Promise<void> =>
      VaultAPI.Rename(vaultId, from, to),
    trash: (vaultId: string, path: string): Promise<string> => VaultAPI.Trash(vaultId, path),
    rebuildIndex: (vaultId: string): Promise<void> => VaultAPI.RebuildIndex(vaultId),
    readConfig: (vaultId: string, name: string): Promise<string> =>
      VaultAPI.ReadConfig(vaultId, name),
    writeConfig: (vaultId: string, name: string, content: string): Promise<void> =>
      VaultAPI.WriteConfig(vaultId, name, content),
    readBinary: (vaultId: string, path: string): Promise<BinaryContent> =>
      VaultAPI.ReadBinary(vaultId, path),
    saveAttachment: (vaultId: string, dir: string, name: string, base64: string): Promise<string> =>
      VaultAPI.SaveAttachment(vaultId, dir, name, base64),
  },
  drawing: {
    /** SVG cached for a drawing content hash ("" when there is none). */
    readPreview: (vaultId: string, hash: string): Promise<string> =>
      DrawingAPI.ReadPreview(vaultId, hash),
    savePreview: (vaultId: string, hash: string, svg: string): Promise<void> =>
      DrawingAPI.SavePreview(vaultId, hash, svg),
  },
  search: {
    query: (
      vaultId: string,
      q: string,
      sort: SearchSort = 'relevance',
      limit = 100,
    ): Promise<SearchResults> => SearchAPI.Query(vaultId, q, sort, limit),
    explain: (q: string): Promise<string[]> => SearchAPI.Explain(q),
  },
  settings: {
    get: (): Promise<AppSettings> => SettingsAPI.Get(),
    set: (s: AppSettings): Promise<void> => SettingsAPI.Set(s),
    info: (): Promise<Record<string, string>> => SettingsAPI.Info(),
  },
  tags: {
    list: (vaultId: string): Promise<TagCount[]> => TagsAPI.List(vaultId),
  },
  properties: {
    keys: (vaultId: string): Promise<PropertyKey[]> => PropertiesAPI.Keys(vaultId),
    schema: (vaultId: string): Promise<Record<string, string>> => PropertiesAPI.Schema(vaultId),
    setType: (vaultId: string, key: string, kind: string): Promise<void> =>
      PropertiesAPI.SetType(vaultId, key, kind),
    update: (
      vaultId: string,
      path: string,
      key: string,
      value: unknown,
      expectedHash: string,
    ): Promise<WriteResult> =>
      PropertiesAPI.Update(vaultId, path, key, JSON.stringify(value), expectedHash),
    remove: (
      vaultId: string,
      path: string,
      key: string,
      expectedHash: string,
    ): Promise<WriteResult> => PropertiesAPI.Remove(vaultId, path, key, expectedHash),
  },
  links: {
    resolve: (vaultId: string, from: string, target: string): Promise<string> =>
      LinksAPI.Resolve(vaultId, from, target),
    suggest: (
      vaultId: string,
      kind: SuggestKind,
      query: string,
      notePath = '',
      limit = 30,
    ): Promise<Suggestion[]> => LinksAPI.Suggest(vaultId, kind, query, notePath, limit),
    outgoing: (vaultId: string, path: string): Promise<NoteLink[]> =>
      LinksAPI.Outgoing(vaultId, path),
    backlinks: (vaultId: string, path: string): Promise<NoteLink[]> =>
      LinksAPI.Backlinks(vaultId, path),
    planRename: (vaultId: string, from: string, to: string): Promise<RenamePlan> =>
      LinksAPI.PlanRename(vaultId, from, to),
    applyRename: (vaultId: string, from: string, to: string): Promise<RenamePlan> =>
      LinksAPI.ApplyRename(vaultId, from, to),
    mentions: (vaultId: string, path: string): Promise<Mention[]> =>
      LinksAPI.UnlinkedMentions(vaultId, path),
  },
  sync: {
    info: (vaultId: string): Promise<SyncLinkInfo> => SyncAPI.Info(vaultId),
    status: (vaultId: string): Promise<SyncStatus> =>
      SyncAPI.Status(vaultId) as Promise<SyncStatus>,
    linkNew: (
      vaultId: string,
      name: string,
      kind: VaultKind,
      passphrase: string,
    ): Promise<SyncLinkResult> => SyncAPI.LinkNew(vaultId, name, kind, passphrase),
    listCloudVaults: (): Promise<CloudVault[]> => SyncAPI.ListCloudVaults(),
    linkExisting: (vaultId: string, cloudVaultId: string): Promise<void> =>
      SyncAPI.LinkExisting(vaultId, cloudVaultId),
    unlink: (vaultId: string): Promise<void> => SyncAPI.Unlink(vaultId),
    setPaused: (vaultId: string, paused: boolean): Promise<void> =>
      SyncAPI.SetPaused(vaultId, paused),
    setPollInterval: (vaultId: string, seconds: number): Promise<void> =>
      SyncAPI.SetPollInterval(vaultId, seconds),
    syncNow: (vaultId: string): Promise<void> => SyncAPI.SyncNow(vaultId),
    conflicts: (vaultId: string): Promise<SyncConflict[]> => SyncAPI.Conflicts(vaultId),
    conflictTexts: (vaultId: string, id: number): Promise<ConflictTexts> =>
      SyncAPI.ConflictTexts(vaultId, id),
    resolveConflict: (
      vaultId: string,
      id: number,
      action: ConflictAction,
      merged = '',
    ): Promise<void> => SyncAPI.ResolveConflict(vaultId, id, action, merged),
    history: (vaultId: string, path: string): Promise<RevisionInfo[]> =>
      SyncAPI.History(vaultId, path),
    revisionText: (vaultId: string, path: string, rev: number): Promise<string> =>
      SyncAPI.RevisionText(vaultId, path, rev),
    restoreRevision: (vaultId: string, path: string, rev: number): Promise<void> =>
      SyncAPI.RestoreRevision(vaultId, path, rev),
    devices: (): Promise<DeviceInfo[]> => SyncAPI.Devices() as Promise<DeviceInfo[]>,
    revokeDevice: (id: string): Promise<void> => SyncAPI.RevokeDevice(id),
    usage: (): Promise<UsageInfo> => SyncAPI.Usage(),
  },
  sharing: {
    invitations: (): Promise<ShareInfo[]> => SharingAPI.Invitations() as Promise<ShareInfo[]>,
    mounts: (): Promise<MountState[]> => SharingAPI.Mounts() as Promise<MountState[]>,
    accept: (shareId: string): Promise<MountState> =>
      SharingAPI.AcceptShare(shareId) as Promise<MountState>,
    decline: (shareId: string): Promise<void> => SharingAPI.DeclineShare(shareId),
    openMount: (shareId: string): Promise<VaultInfo> => SharingAPI.OpenMount(shareId),
    removeMount: (shareId: string, keepCopy: boolean): Promise<VaultInfo> =>
      SharingAPI.RemoveMount(shareId, keepCopy),
    vaultShares: (vaultId: string): Promise<ShareInfo[]> =>
      SharingAPI.VaultShares(vaultId) as Promise<ShareInfo[]>,
    create: (
      vaultId: string,
      path: string,
      isDir: boolean,
      name: string,
      grants: GrantInput[],
      expiresAt = '',
    ): Promise<ShareInfo> =>
      SharingAPI.CreateShare(vaultId, path, isDir, name, grants, expiresAt) as Promise<ShareInfo>,
    share: (shareId: string): Promise<ShareInfo> => SharingAPI.Share(shareId) as Promise<ShareInfo>,
    revoke: (shareId: string): Promise<void> => SharingAPI.RevokeShare(shareId),
    setGrant: (
      shareId: string,
      principalType: 'user' | 'group',
      principalId: string,
      permission: PermissionLevel,
    ): Promise<ShareGrant> =>
      SharingAPI.SetGrant(shareId, principalType, principalId, permission) as Promise<ShareGrant>,
    removeGrant: (
      shareId: string,
      principalType: 'user' | 'group',
      principalId: string,
    ): Promise<void> => SharingAPI.RemoveGrant(shareId, principalType, principalId),
    directory: (query: string): Promise<DirectoryEntry[]> =>
      SharingAPI.Directory(query) as Promise<DirectoryEntry[]>,
  },
  config: {
    effective: (): Promise<ConfigState> => ConfigAPI.Effective(),
    refresh: (): Promise<ConfigState> => ConfigAPI.Refresh(),
  },
  crypto: {
    unlock: (vaultId: string, secret: string, isRecovery: boolean): Promise<boolean> =>
      VaultCryptoAPI.Unlock(vaultId, secret, isRecovery),
    lock: (vaultId: string): Promise<void> => VaultCryptoAPI.Lock(vaultId),
    setPassphrase: (vaultId: string, newPassphrase: string): Promise<void> =>
      VaultCryptoAPI.SetPassphrase(vaultId, newPassphrase),
    changePassphrase: (
      vaultId: string,
      oldPassphrase: string,
      newPassphrase: string,
    ): Promise<void> => VaultCryptoAPI.ChangePassphrase(vaultId, oldPassphrase, newPassphrase),
    regenerateRecoveryKey: (vaultId: string, passphrase: string): Promise<string> =>
      VaultCryptoAPI.RegenerateRecoveryKey(vaultId, passphrase),
    diskEncryption: (): Promise<DiskEncryption> =>
      VaultCryptoAPI.DiskEncryption() as Promise<DiskEncryption>,
  },
  auth: {
    status: (): Promise<AuthState> => AuthAPI.Status(),
    login: (serverUrl: string): Promise<AuthState> => AuthAPI.Login(serverUrl),
    logout: (): Promise<AuthState> => AuthAPI.Logout(),
  },
  /** Subscribes to a backend event; returns the unsubscribe function. */
  on<T>(name: string, handler: (payload: T) => void): () => void {
    return EventsOn(name, handler as (...data: unknown[]) => void);
  },
};

/** Backend errors are plain messages prefixed with a stable code ("conflict: …"). */
export function errorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const i = msg.indexOf(':');
  return i > 0 ? msg.slice(0, i) : msg;
}
