// Public signature of @memobrain/workbench as the desktop entry uses it (tsconfig.app.json maps the
// package to this file, so the workbench sources are not compiled twice).
export interface WorkbenchOptions {
  kind?: 'desktop' | 'web';
  onBackToConsole?: () => void;
  vaultPath?: string;
}
export declare function mountWorkbench(
  root: HTMLElement,
  options?: WorkbenchOptions,
): Promise<void>;
