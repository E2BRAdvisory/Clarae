// Public signature of @memobrain/workbench as the Web UI uses it (tsconfig.app.json maps the package to
// this file, so the workbench sources are not compiled twice; they are type-checked by their own project).
export interface WorkbenchOptions {
  kind?: 'desktop' | 'web';
  onBackToConsole?: () => void;
  vaultPath?: string;
}
export declare function mountWorkbench(
  root: HTMLElement,
  options?: WorkbenchOptions,
): Promise<void>;
