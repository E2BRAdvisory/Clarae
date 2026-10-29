/**
 * Opens a cloud vault in the browser: starts the Go core, links the vault to this browser as a device
 * (the same flow as "link an existing vault" on the desktop), and mounts the desktop UI on top of it.
 */
import type { AuthService } from '../auth/types';
import { installWailsGlobals, startCore, type CoreHandle } from './bridge';
import { watchIdle } from './idle';
import type { CoreAssets } from './protocol';

/** Where the vaults of this browser live in the core's file system. */
export const VAULTS_DIR = '/vaults';

export interface LaunchOptions {
  auth: AuthService;
  /** Cloud vault to open, or the share of a mount. */
  vaultId: string;
  share: string | null;
  /** Open the folder without linking it to the cloud (tests, and a browser without a session). */
  localOnly: boolean;
  assets: CoreAssets;
  version: string;
  /** Mounts the workbench UI; provided by the entry so this module stays free of the UI bundle. */
  mount(options: { vaultPath: string; onBackToConsole: () => void }): Promise<void>;
  /** Progress for the loading screen. */
  progress(step: 'core' | 'session' | 'vault' | 'ui'): void;
  /** Log the core's file system calls (diagnostics; E2E builds only). */
  fsTrace?: boolean;
  /** Minutes without input before a private vault is locked and wiped (default 15). */
  idleMinutes?: number;
}

export interface Launched {
  core: CoreHandle;
  /** Local id of the open vault. */
  localId: string;
  kind: string;
}

/** The error launchWorkbench throws when the administrator turned the workbench off. */
export const DISABLED = 'web_workbench disabled';

export const backToConsole = (): void => window.location.assign('/vaults');

interface VaultInfo {
  id: string;
  name: string;
  path: string;
}
interface LinkInfo {
  linked: boolean;
  kind?: string;
}
interface AuthState {
  status: string;
  error?: string;
}

/** Waits until the core has a cloud session (it asks the page for a token and loads the profile). */
async function waitForSession(core: CoreHandle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: AuthState = { status: 'unknown' };
  while (Date.now() < deadline) {
    last = await core.call<AuthState>('AuthAPI', 'Status');
    if (last.status === 'ready') return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no cloud session (${last.status}${last.error ? `: ${last.error}` : ''})`);
}

export async function launchWorkbench(o: LaunchOptions): Promise<Launched> {
  const getToken = async (): Promise<string> => {
    const user = await o.auth.getUser();
    if (!user) {
      // A page without a cloud (localOnly) has nobody to sign in: the core simply stays disconnected.
      if (!o.localOnly) void o.auth.signIn(`${location.pathname}${location.search}`);
      throw new Error('signed out');
    }
    return user.accessToken;
  };

  o.progress('core');
  const core = await startCore({
    assets: o.assets,
    config: {
      dataDir: '/memobrain/data',
      version: o.version,
      logLevel: 'warn',
      ...(o.fsTrace ? { fsTrace: true } : {}),
    },
    getToken,
    onQuit: backToConsole,
  });
  await core.start();
  installWailsGlobals(core);
  core.domReady();
  // Leaving the page: let the core close its databases (best effort, the page may already be going away).
  window.addEventListener('pagehide', () => void core.shutdown().catch(() => undefined));

  if (!o.localOnly) {
    // The administrator may have switched the workbench off (feature `web_workbench`): a typed address does not bypass it.
    await waitForSession(core);
    const state = await core.call<{ features?: Record<string, boolean> }>('ConfigAPI', 'Effective');
    if (state.features?.['web_workbench'] === false) {
      core.terminate();
      throw new Error(DISABLED);
    }
  }

  let info: VaultInfo;
  if (o.share) {
    o.progress('session');
    await waitForSession(core);
    o.progress('vault');
    info = await core.call<VaultInfo>('SharingAPI', 'OpenMount', o.share);
  } else {
    if (!o.localOnly) {
      o.progress('session');
      await waitForSession(core);
    }
    o.progress('vault');
    info = await core.call<VaultInfo>('VaultAPI', 'OpenVault', `${VAULTS_DIR}/${o.vaultId}`);
    if (!o.localOnly) {
      const link = await core.call<LinkInfo>('SyncAPI', 'Info', info.id);
      if (!link.linked) {
        await core.call('SyncAPI', 'LinkExisting', info.id, o.vaultId);
        // The folder is named by cloud id; reopening it shows the name the user gave the vault.
        await core.call('VaultAPI', 'CloseVault', info.id);
        info = await core.call<VaultInfo>('VaultAPI', 'OpenVault', `${VAULTS_DIR}/${o.vaultId}`);
      }
    }
  }
  const link = await core
    .call<LinkInfo>('SyncAPI', 'Info', info.id)
    .catch((): LinkInfo => ({ linked: false }));
  const kind = link.kind ?? '';

  o.progress('ui');
  await o.mount({ vaultPath: info.path, onBackToConsole: backToConsole });
  if (import.meta.env.MEMOBRAIN_E2E) {
    // Playwright drives the core and the lock-and-forget path directly.
    Object.assign(window, {
      __core: core,
      __lockAndForget: () => lockAndForget(core, info, VAULTS_DIR),
    });
  }

  // A private vault does not stay open on an unattended screen: lock it, remove the clear-text copy
  // this browser holds, and go back to the console (ADR-0029).
  if (kind === 'private') {
    watchIdle((o.idleMinutes ?? 15) * 60_000, () => {
      void lockAndForget(core, info, VAULTS_DIR).finally(backToConsole);
    });
  }
  return { core, localId: info.id, kind };
}

/** Locks a vault, closes it and deletes its copy from this browser. */
export async function lockAndForget(
  core: CoreHandle,
  info: VaultInfo,
  vaultsDir: string,
): Promise<void> {
  await core.call('VaultCryptoAPI', 'Lock', info.id).catch(() => undefined);
  await core.call('VaultAPI', 'CloseVault', info.id).catch(() => undefined);
  await core
    .wipe(info.path.startsWith(vaultsDir) ? info.path : `${vaultsDir}/${info.id}`)
    .catch(() => undefined);
}
