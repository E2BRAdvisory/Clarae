// Public signature of @clarae/workbench as the desktop entry uses it (tsconfig.app.json maps the
// package to this file, so the workbench sources are not compiled twice).
export interface WorkbenchOptions {
  kind?: 'desktop' | 'web';
  onBackToConsole?: () => void;
  vaultPath?: string;
}
export interface WorkbenchHandle {
  /** Writes the pending edits (bounded wait, never rejects); call before tearing the page down. */
  flush(): Promise<void>;
}
export declare function mountWorkbench(
  root: HTMLElement,
  options?: WorkbenchOptions,
): Promise<WorkbenchHandle>;
/** The page of the separate terminal window (the `@clarae/workbench/terminal-window` entry, ADR-0064). */
export declare function mountTerminalWindow(
  root: HTMLElement,
  options?: Pick<WorkbenchOptions, 'kind'>,
): Promise<void>;
