// Public signature of @memobrain/workbench as the Web UI uses it (tsconfig.app.json maps the package to
// this file, so the workbench sources are not compiled twice; they are type-checked by their own project).
export interface MountRef {
  shareId: string;
  cloudVaultId: string;
}
export interface WorkbenchOptions {
  kind?: 'desktop' | 'web';
  onBackToConsole?: () => void;
  vaultPath?: string;
  onRemoveFromBrowser?: () => void;
  /** Opens a mount of Settings › Sharing in its own page. */
  onOpenMount?: (mount: MountRef) => void;
  /** A mount's copy was removed from this browser (Settings › Sharing). */
  onMountRemoved?: (shareId: string) => void;
}
export interface WorkbenchHandle {
  /** Writes the pending edits (bounded wait, never rejects); call before tearing the page down. */
  flush(): Promise<void>;
}
export declare function mountWorkbench(
  root: HTMLElement,
  options?: WorkbenchOptions,
): Promise<WorkbenchHandle>;
export interface CreateCloudVaultOptions {
  vaultId: string;
  name: string;
  kind: 'shared' | 'private';
  onCreated: (cloudVaultId: string) => void;
  onCancel: () => void;
}
/** Runs the workbench's connect wizard preset for a new cloud vault; resolves to its unmount. */
export declare function mountCreateCloudVault(
  root: HTMLElement,
  options: CreateCloudVaultOptions,
): Promise<() => void>;
