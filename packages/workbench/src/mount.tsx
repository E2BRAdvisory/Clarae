import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import 'katex/dist/katex.min.css';
import { App } from './app/App';
import { api } from './app/api';
import { useAppStore } from './state/store';
import { flushWorkbench, installLifecycle } from './app/lifecycle';
import { initI18n } from './i18n';
import {
  configurePlatform,
  loadCoreCapabilities,
  usesWailsBindings,
  type PlatformOptions,
} from './platform';
import { queryClient } from './state/queryClient';
import { installLinkGuard } from './util/links';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { importWithRetry } from './ui/lazyView';
import './style.css';

export type WorkbenchOptions = PlatformOptions;

/** What the host can do with a mounted workbench. */
export interface WorkbenchHandle {
  /**
   * Writes every pending edit (what cannot be saved in its file goes to a copy next to it) and the
   * workspace. Call it before tearing the page down; it resolves within a few seconds, never rejects.
   */
  flush(): Promise<void>;
}

/**
 * Mounts the workbench (the whole vault UI) in `root`. The host provides the backend before
 * calling it (the Wails bindings on the desktop, a bridge to the Go core in the browser) and says
 * what kind of host it is, so the UI shows only what that host can do.
 */
export async function mountWorkbench(
  root: HTMLElement,
  options: WorkbenchOptions = {},
): Promise<WorkbenchHandle> {
  const back = options.onBackToConsole;
  configurePlatform({
    ...options,
    // Leaving for the console writes the pending edits first.
    ...(back ? { onBackToConsole: () => void flushWorkbench().finally(back) } : {}),
  });
  initI18n();
  // Playwright runs the desktop UI in a plain browser: swap the Wails bindings for the in-memory mock.
  // A web host brings its own backend (the Go core), which must never be replaced.
  if (import.meta.env.MEMOBRAIN_E2E && usesWailsBindings()) {
    const { installWailsMock } = await import('./test/wails-mock');
    (window as unknown as { __mock: unknown }).__mock = installWailsMock();
  }
  // What this host offers comes from its core (ADR-0045 §1), before anything reads it: the
  // lifecycle below (nativeWindow) and every control of the first render.
  await loadCoreCapabilities(() => api.settings.capabilities());
  installLifecycle();
  // No rendered link may navigate the window away from the app (each view routes its own links).
  installLinkGuard();
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary scope="shell">
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
  return { flush: () => flushWorkbench() };
}

export interface CreateCloudVaultOptions {
  /** The local vault (an empty folder the host opened) to link to the new cloud vault. */
  vaultId: string;
  /** Name and kind chosen in the console. */
  name: string;
  kind: 'shared' | 'private';
  /** Linked: for a private vault, once the recovery key was retyped. */
  onCreated: (cloudVaultId: string) => void;
  onCancel: () => void;
}

/**
 * Web host only: runs the "connect to the cloud" wizard on its own, preset with the name and the
 * kind chosen in the console, to create a cloud vault from an empty folder of the browser. A
 * private vault's keys (envelopes, recovery key) are made by the Go core behind SyncAPI.LinkNew,
 * never in TypeScript (ADR-0037 §2). The host unmounts it (the returned function) before mounting
 * the workbench on the new vault.
 */
export async function mountCreateCloudVault(
  root: HTMLElement,
  options: CreateCloudVaultOptions,
): Promise<() => void> {
  configurePlatform({ kind: 'web' });
  initI18n();
  // The wizard is not part of the workbench's startup bundle (SyncDialogs loads it on demand too).
  const [{ ConnectWizard }, auth] = await Promise.all([
    importWithRetry(() => import('./sync/ConnectWizard')),
    api.auth.status(),
    loadCoreCapabilities(() => api.settings.capabilities()),
  ]);
  useAppStore.getState().setAuth(auth);
  const r = createRoot(root);
  r.render(
    <StrictMode>
      <ErrorBoundary scope="shell">
        <ConnectWizard
          vaultId={options.vaultId}
          vaultName={options.name}
          preset={{
            kind: options.kind,
            name: options.name,
            onLinked: options.onCreated,
            onCancel: options.onCancel,
          }}
        />
      </ErrorBoundary>
    </StrictMode>,
  );
  return () => r.unmount();
}
