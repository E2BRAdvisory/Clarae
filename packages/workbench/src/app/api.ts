// Thin typed facade over the generated Wails bindings (wailsjs/, do not edit)
// so the rest of the frontend imports one module and tests can mock it.
// Model types are exposed as plain data shapes (without the generated
// `convertValues` helper) so literals and mocks type-check structurally.
import * as VaultAPI from '../../wailsjs/go/app/VaultAPI';
import * as SearchAPI from '../../wailsjs/go/app/SearchAPI';
import * as ExportAPI from '../../wailsjs/go/app/ExportAPI';
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
import * as GraphAPI from '../../wailsjs/go/app/GraphAPI';
import type { GraphData, GraphOptions } from '../graph/types';
import * as BasesAPI from '../../wailsjs/go/app/BasesAPI';
import type { BaseInfo, BaseResult, ViewPatch } from '../bases/types';
import * as TemplatesAPI from '../../wailsjs/go/app/TemplatesAPI';
import * as ComposerAPI from '../../wailsjs/go/app/ComposerAPI';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import type { EventName, EventPayload } from './events.gen';
import type { Capabilities } from '../platform';
import type { Schemas } from '@memobrain/api-client';
import type { app, auth, composer, links, search, sync, vault } from '../../wailsjs/go/models';
import * as HistoryAPI from '../../wailsjs/go/app/HistoryAPI';
import type { history as localHistory } from '../../wailsjs/go/models';

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
export type MountState = Omit<Plain<sync.MountState>, 'permission' | 'resourceType'> & {
  permission: PermissionLevel;
  resourceType: 'vault' | 'folder' | 'file';
};
export type ConfigState = Plain<app.ConfigState>;
export type TemplateInfo = Omit<Plain<app.TemplateInfo>, 'source'> & {
  source: 'vault' | 'library';
};
export type NoteResult = Plain<app.NoteResult>;
export type DailyOptions = Plain<app.DailyOptions>;
export type UniqueOptions = Plain<app.UniqueOptions>;
export type MergePlan = Plain<composer.MergePlan>;
export type MergeResult = Plain<composer.MergeResult>;
export type ExtractOptions = Plain<composer.ExtractOptions>;
export type ExtractResult = Plain<composer.ExtractResult>;
export type SyncLinkResult = Plain<sync.LinkResult>;
export type SyncPhase = 'idle' | 'syncing' | 'paused' | 'offline' | 'error' | 'locked';
export type SyncStatus = Omit<Plain<sync.Status>, 'phase' | 'lastSync'> & {
  phase: SyncPhase;
  lastSync: string;
};
export type SyncConflict = Omit<Plain<sync.Conflict>, 'createdAt'> & { createdAt: string };
export type RevisionInfo = Omit<Plain<sync.RevisionInfo>, 'time'> & { time: string };
export type HistorySnapshot = Omit<Plain<localHistory.Snapshot>, 'time'> & { time: string };
export type HistoryDeleted = Omit<Plain<localHistory.Deleted>, 'time'> & { time: string };
export type HistorySettings = Plain<localHistory.Settings>;
// The cloud-management bindings speak the OpenAPI types (ADR-0045 §6): their models (package
// cloudapi of the core) equal these Schemas, which cloud/bindingTypes.test.ts asserts.
export type CloudVault = Schemas['Vault'];
/** A device of the account; `current` marks the device the core runs on. */
export type CloudDevice = Schemas['Device'] & { current: boolean };
export type CloudUsage = Schemas['Usage'];
export type Share = Schemas['Share'];
/** A page of shares (GET /shares): `next_cursor` is absent on the last page. */
export type SharePage = Schemas['SharePage'];
export type ShareGrant = Schemas['Grant'];
export type NewGrant = Schemas['NewGrant'];
export type ShareUpdate = Schemas['UpdateShare'];
export type DirectoryUser = Schemas['DirectoryUser'];
export type DirectoryGroup = Schemas['DirectoryGroup'];
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
    /** (Over)writes "<drawing>.[light.|dark.]png|svg" next to the drawing; returns its path. */
    writeExport: (
      vaultId: string,
      drawingPath: string,
      variant: '' | 'light' | 'dark',
      format: 'png' | 'svg',
      base64: string,
    ): Promise<string> => DrawingAPI.WriteExport(vaultId, drawingPath, variant, format, base64),
    /** Converts an Obsidian ".excalidraw.md" into a ".excalidraw" next to it; returns its path. */
    importLegacy: (vaultId: string, path: string): Promise<string> =>
      DrawingAPI.ImportLegacy(vaultId, path),
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
  exporter: {
    /** Asks where to save (native dialog) and writes a standalone HTML document. */
    saveHtml: (vaultId: string, name: string, html: string): Promise<ExportResult> =>
      ExportAPI.SaveHTML(vaultId, name, html),
    /** Opens the system print dialog (PDF through "Save as PDF"). */
    print: (): Promise<void> => ExportAPI.Print(),
    /** Asks where to save (native dialog) a PNG, SVG, PDF or excalidraw JSON given as base64. */
    saveFile: (
      vaultId: string,
      name: string,
      mime: string,
      base64: string,
    ): Promise<ExportResult> => ExportAPI.SaveFile(vaultId, name, mime, base64),
  },
  settings: {
    get: (): Promise<AppSettings> => SettingsAPI.Get(),
    set: (s: AppSettings): Promise<void> => SettingsAPI.Set(s),
    info: (): Promise<Record<string, string>> => SettingsAPI.Info(),
    /** What this host offers (ADR-0045 §1); typed against the platform layer, so the two cannot drift. */
    capabilities: (): Promise<Capabilities> => SettingsAPI.Capabilities(),
  },
  tags: {
    list: (vaultId: string): Promise<TagCount[]> => TagsAPI.List(vaultId),
  },
  bases: {
    load: (vaultId: string, path: string): Promise<BaseInfo> =>
      BasesAPI.Load(vaultId, path) as unknown as Promise<BaseInfo>,
    run: (vaultId: string, path: string, viewIndex: number, thisPath = ''): Promise<BaseResult> =>
      BasesAPI.Run(vaultId, path, viewIndex, thisPath),
    updateView: (
      vaultId: string,
      path: string,
      viewIndex: number,
      patch: ViewPatch,
      expectedHash: string,
    ): Promise<WriteResult> =>
      BasesAPI.UpdateView(vaultId, path, viewIndex, JSON.stringify(patch), expectedHash),
    updateProperty: (
      vaultId: string,
      notePath: string,
      key: string,
      value: unknown,
      expectedHash: string,
    ): Promise<WriteResult> =>
      BasesAPI.UpdateProperty(vaultId, notePath, key, JSON.stringify(value), expectedHash),
    newContent: (folder: string): Promise<string> => BasesAPI.NewBaseContent(folder),
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
    /** Soft-deleted vaults of the account that can still be restored (deleted_at set). */
    listDeletedCloudVaults: (): Promise<CloudVault[]> => SyncAPI.ListDeletedCloudVaults(),
    renameCloudVault: (cloudVaultId: string, name: string): Promise<CloudVault> =>
      SyncAPI.RenameCloudVault(cloudVaultId, name),
    /** Soft delete; the vaults of this device linked to it are disconnected and keep their files. */
    deleteCloudVault: (cloudVaultId: string): Promise<void> =>
      SyncAPI.DeleteCloudVault(cloudVaultId),
    restoreCloudVault: (cloudVaultId: string): Promise<CloudVault> =>
      SyncAPI.RestoreCloudVault(cloudVaultId),
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
    devices: (): Promise<CloudDevice[]> => SyncAPI.Devices(),
    revokeDevice: (id: string): Promise<void> => SyncAPI.RevokeDevice(id),
    usage: (): Promise<CloudUsage> => SyncAPI.Usage(),
  },
  history: {
    list: (vaultId: string, path: string): Promise<HistorySnapshot[]> =>
      HistoryAPI.List(vaultId, path),
    read: (
      vaultId: string,
      snapshotId: string,
    ): Promise<{ snapshot: HistorySnapshot; content: string }> =>
      HistoryAPI.Read(vaultId, snapshotId),
    restore: (vaultId: string, snapshotId: string): Promise<WriteResult> =>
      HistoryAPI.Restore(vaultId, snapshotId),
    listDeleted: (vaultId: string): Promise<HistoryDeleted[]> => HistoryAPI.ListDeleted(vaultId),
    getSettings: (vaultId: string): Promise<HistorySettings> => HistoryAPI.GetSettings(vaultId),
    setSettings: (vaultId: string, s: HistorySettings): Promise<HistorySettings> =>
      HistoryAPI.SetSettings(vaultId, s),
  },
  sharing: {
    invitations: (): Promise<Share[]> => SharingAPI.Invitations(),
    mounts: (): Promise<MountState[]> => SharingAPI.Mounts() as Promise<MountState[]>,
    accept: (shareId: string): Promise<MountState> =>
      SharingAPI.AcceptShare(shareId) as Promise<MountState>,
    decline: (shareId: string): Promise<void> => SharingAPI.DeclineShare(shareId),
    openMount: (shareId: string): Promise<VaultInfo> => SharingAPI.OpenMount(shareId),
    removeMount: (shareId: string, keepCopy: boolean): Promise<VaultInfo> =>
      SharingAPI.RemoveMount(shareId, keepCopy),
    vaultShares: (vaultId: string): Promise<Share[]> => SharingAPI.VaultShares(vaultId),
    create: (
      vaultId: string,
      path: string,
      isDir: boolean,
      name: string,
      grants: NewGrant[],
      expiresAt = '',
    ): Promise<Share> => SharingAPI.CreateShare(vaultId, path, isDir, name, grants, expiresAt),
    /**
     * A page of the shares of the account: created or managed by the user ("owned"), or received.
     * cursor is "" for the first page, then the `next_cursor` of the page before.
     */
    list: (scope: 'owned' | 'received', cursor = ''): Promise<SharePage> =>
      SharingAPI.ListShares(scope, cursor),
    /** Shares a whole cloud vault (empty pathPrefix) or one of its folders, by cloud vault id. */
    createCloud: (
      cloudVaultId: string,
      pathPrefix: string,
      name: string,
      grants: NewGrant[],
      expiresAt = '',
    ): Promise<Share> =>
      SharingAPI.CreateCloudShare(cloudVaultId, pathPrefix, name, grants, expiresAt),
    /** The body of PATCH /shares/{id}: a new name, a new expiry, or `clear_expiry`. */
    update: (shareId: string, change: ShareUpdate): Promise<Share> =>
      SharingAPI.UpdateShare(shareId, change),
    share: (shareId: string): Promise<Share> => SharingAPI.Share(shareId),
    revoke: (shareId: string): Promise<void> => SharingAPI.RevokeShare(shareId),
    setGrant: (
      shareId: string,
      principalType: 'user' | 'group',
      principalId: string,
      permission: PermissionLevel,
    ): Promise<ShareGrant> => SharingAPI.SetGrant(shareId, principalType, principalId, permission),
    removeGrant: (
      shareId: string,
      principalType: 'user' | 'group',
      principalId: string,
    ): Promise<void> => SharingAPI.RemoveGrant(shareId, principalType, principalId),
    /** Users to share with (GET /directory/users). */
    searchUsers: (query: string): Promise<DirectoryUser[]> =>
      SharingAPI.SearchDirectoryUsers(query),
    /** Groups to share with (GET /directory/groups). */
    searchGroups: (query: string): Promise<DirectoryGroup[]> =>
      SharingAPI.SearchDirectoryGroups(query),
  },
  config: {
    effective: (): Promise<ConfigState> => ConfigAPI.Effective(),
    refresh: (): Promise<ConfigState> => ConfigAPI.Refresh(),
  },
  templates: {
    /** Settings of daily notes, unique notes and templates (.memobrain/daily.json; "" when unset). */
    readSettings: (vaultId: string): Promise<string> => TemplatesAPI.ReadSettings(vaultId),
    writeSettings: (vaultId: string, content: string): Promise<void> =>
      TemplatesAPI.WriteSettings(vaultId, content),
    /** Templates of the vault folder plus the read-only group library when mounted. */
    list: (vaultId: string, folder: string): Promise<TemplateInfo[]> =>
      TemplatesAPI.List(vaultId, folder) as Promise<TemplateInfo[]>,
    expand: (vaultId: string, ref: string, title: string, lang: string): Promise<string> =>
      TemplatesAPI.Expand(vaultId, ref, title, lang),
    openDaily: (vaultId: string, o: DailyOptions): Promise<NoteResult> =>
      TemplatesAPI.OpenDaily(vaultId, o),
    dailyAdjacent: (
      path: string,
      folder: string,
      format: string,
      lang: string,
      delta: number,
    ): Promise<string> => TemplatesAPI.DailyAdjacent(path, folder, format, lang, delta),
    newUnique: (vaultId: string, o: UniqueOptions): Promise<NoteResult> =>
      TemplatesAPI.NewUnique(vaultId, o),
    createFromTemplate: (
      vaultId: string,
      dir: string,
      name: string,
      ref: string,
      lang: string,
    ): Promise<string> => TemplatesAPI.CreateFromTemplate(vaultId, dir, name, ref, lang),
  },
  composer: {
    planMerge: (vaultId: string, source: string, target: string): Promise<MergePlan> =>
      ComposerAPI.PlanMerge(vaultId, source, target),
    applyMerge: (
      vaultId: string,
      source: string,
      target: string,
      separator: string,
    ): Promise<MergeResult> => ComposerAPI.ApplyMerge(vaultId, source, target, separator),
    suggestTitle: (selection: string): Promise<string> => ComposerAPI.SuggestTitle(selection),
    extract: (vaultId: string, o: ExtractOptions): Promise<ExtractResult> =>
      ComposerAPI.Extract(vaultId, o),
  },
  crypto: {
    unlock: (vaultId: string, secret: string, isRecovery: boolean): Promise<boolean> =>
      VaultCryptoAPI.Unlock(vaultId, secret, isRecovery),
    lock: (vaultId: string): Promise<void> => VaultCryptoAPI.Lock(vaultId),
    /** User activity: restarts the idle timer of the unlocked private vaults (see app/activity). */
    activity: (): Promise<void> => VaultCryptoAPI.Activity(),
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
    /** Replaces a device the cloud refuses as revoked with a new registration (status device_revoked). */
    reregisterDevice: (): Promise<AuthState> => AuthAPI.ReregisterDevice(),
  },
  graph: {
    /** Nodes and edges of the vault (or the neighbourhood of options.center) from the local index. */
    build: (vaultId: string, options: GraphOptions): Promise<GraphData> =>
      GraphAPI.Build(vaultId, options),
  },
  /**
   * Subscribes to a backend event (`Events.<key>`; names and payload types are generated from the Go
   * registry, app/events.gen.ts); returns the unsubscribe function.
   */
  on<N extends EventName>(name: N, handler: (payload: EventPayload<N>) => void): () => void {
    return EventsOn(name, handler as (...data: unknown[]) => void);
  },
};

/** Backend errors are plain messages prefixed with a stable code ("conflict: …"). */
export function errorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const i = msg.indexOf(':');
  return i > 0 ? msg.slice(0, i) : msg;
}
