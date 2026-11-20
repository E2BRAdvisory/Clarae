import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../app/api';
import { installActivityFeed } from '../app/activity';
import { initI18n } from '../i18n';
import {
  configurePlatform,
  loadCoreCapabilities,
  usesWailsBindings,
  type PlatformOptions,
} from '../platform';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { installLinkGuard } from '../util/links';
import '../style.css';
import { TerminalWindow } from './TerminalWindow';

/**
 * Mounts the page of the separate terminal window (ADR-0064): the same panel as the main window's, filling
 * the window. The host provides the backend before calling it, as for mountWorkbench. The idle lock of the
 * private vaults hears the keys typed here too (this page has its own listeners).
 */
export async function mountTerminalWindow(
  root: HTMLElement,
  options: PlatformOptions = {},
): Promise<void> {
  configurePlatform(options);
  initI18n();
  // Playwright runs the desktop UI in a plain browser: the bindings are the in-memory mock.
  if (import.meta.env.CLARAE_E2E && usesWailsBindings()) {
    const { installWailsMock } = await import('../test/wails-mock');
    (window as unknown as { __mock: unknown }).__mock = installWailsMock();
  }
  await loadCoreCapabilities(() => api.settings.capabilities());
  installActivityFeed();
  installLinkGuard();
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary scope="shell">
        <TerminalWindow />
      </ErrorBoundary>
    </StrictMode>,
  );
}
