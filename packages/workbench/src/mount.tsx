import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import 'katex/dist/katex.min.css';
import { App } from './app/App';
import { initI18n } from './i18n';
import { configurePlatform, type PlatformOptions } from './platform';
import { queryClient } from './state/queryClient';
import './style.css';

export type WorkbenchOptions = PlatformOptions;

/**
 * Mounts the workbench (the whole vault UI) in `root`. The host provides the backend before
 * calling it (the Wails bindings on the desktop, a bridge to the Go core in the browser) and says
 * what kind of host it is, so the UI shows only what that host can do.
 */
export async function mountWorkbench(
  root: HTMLElement,
  options: WorkbenchOptions = {},
): Promise<void> {
  configurePlatform(options);
  initI18n();
  // Playwright runs the desktop UI in a plain browser: swap the Wails bindings for the in-memory mock.
  // A web host brings its own backend (the Go core), which must never be replaced.
  if (import.meta.env.MEMOBRAIN_E2E && options.kind !== 'web') {
    const { installWailsMock } = await import('./test/wails-mock');
    (window as unknown as { __mock: unknown }).__mock = installWailsMock();
  }
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
