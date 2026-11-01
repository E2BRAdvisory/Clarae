/**
 * Opens a cloud vault in the browser: starts the Go core, links the vault to this browser as a device
 * (the same flow as "link an existing vault" on the desktop), and mounts the desktop UI on top of it.
 *
 * What the browser keeps of a private vault is clear text, so it does not outlive the session
 * (ADR-0029 §6): the core locks the vault (manually or after the idle time it is configured with) and the
 * guard (guard.ts) then removes the copy; a copy left behind by a closed tab is removed by the sweep at the
 * next start. Copies with changes not uploaded yet are never removed without asking (D-04).
 */
import { Feature, featureEnabled } from '@memobrain/api-client/features';
import type { AuthService } from '../auth/types';
import { createCoreWorker, installWailsGlobals, startCore, type CoreHandle } from './bridge';
import { VAULTS_DIR, folderOf, runCreation, type Creation, type MountCreate } from './create';
import { onLeaveRequest } from './forget';
import { createVaultGuard, needsGate, type VaultGuard } from './guard';
import { sweepPrivateCopies } from './markers';
import { showFatal, showUnlockGate } from './overlay';
import type { CoreAssets } from './protocol';

export { VAULTS_DIR };

export interface LaunchOptions {
  auth: AuthService;
  /** Cloud vault to open, or the share of a mount. */
  vaultId: string;
  share: string | null;
  /**
   * The creation route (`/vaults/new/open?kind=private&name=…`, see create.ts): a private vault is
   * created first, with the workbench's connect wizard (`mountCreate`), then opened as usual.
   */
  create?: Creation | null;
  mountCreate?: (options: MountCreate) => Promise<() => void>;
  /** Open the folder without linking it to the cloud (tests, and a browser without a session). */
  localOnly: boolean;
  assets: CoreAssets;
  version: string;
  /**
   * Mounts the workbench UI; provided by the entry so this module stays free of the UI bundle. The
   * handle it resolves lets leaving the page write the pending edits first.
   */
  mount(options: {
    vaultPath: string;
    onBackToConsole: () => void;
    /** "Remove from this browser" in the sync settings (only for a copy linked to the cloud). */
    onRemoveFromBrowser?: () => void;
  }): Promise<WorkbenchHandle | void>;
  /** Progress for the loading screen. */
  progress(step: 'core' | 'session' | 'vault' | 'ui'): void;
  /** Log the core's file system calls (diagnostics; E2E builds only). */
  fsTrace?: boolean;
}

export interface Launched {
  core: CoreHandle;
  /** Local id of the open vault. */
  localId: string;
  kind: string;
}

/** The error launchWorkbench throws when the administrator turned the workbench off. */
export const DISABLED = 'web_workbench disabled';
/** The error launchWorkbench throws when the user cancelled the creation of a vault (the page is leaving). */
export const CANCELLED = 'vault creation cancelled';

/** What launch needs of the mounted workbench (see mountWorkbench). */
export interface WorkbenchHandle {
  flush(): Promise<void>;
}

/** How long leaving the page waits for the workbench to write its pending edits. */
const LEAVE_FLUSH_MS = 5_000;

/**
 * Time limits of the start-up calls: a core that stopped answering must end in an error message, not
 * in a loading screen forever. Opening and linking index the vault, hence the generous limits.
 */
const LIMITS = {
  status: 10_000,
  config: 30_000,
  info: 30_000,
  open: 180_000,
  link: 180_000,
  close: 60_000,
};

let workbench: WorkbenchHandle | null = null;
let guard: VaultGuard | null = null;

const goToConsole = (): void => window.location.assign('/vaults');

/** Writes the workbench's pending edits (bounded wait, never rejects). */
async function flushWorkbench(): Promise<void> {
  const wb = workbench;
  if (!wb) return;
  await Promise.race([
    wb.flush().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, LEAVE_FLUSH_MS)),
  ]);
}

/**
 * Goes back to the console once the workbench wrote its pending edits. A private vault is uploaded,
 * locked and removed from the browser first, or kept with a word of explanation when it holds changes
 * that could not be uploaded.
 */
export async function backToConsole(): Promise<void> {
  if (guard) return guard.leave();
  await flushWorkbench();
  goToConsole();
}

interface VaultInfo {
  id: string;
  name: string;
  path: string;
}
interface LinkInfo {
  linked: boolean;
  kind?: string;
  locked?: boolean;
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
    last = await core.callWithin<AuthState>(LIMITS.status, 'AuthAPI', 'Status');
    if (last.status === 'ready') return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no cloud session (${last.status}${last.error ? `: ${last.error}` : ''})`);
}

type Bindings = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

/** Tells the guard when the workbench's own unlock dialog unlocked the vault (window.go is what it calls). */
function watchUnlock(localId: string, g: VaultGuard): void {
  const crypto = (window as unknown as { go?: { app?: Bindings } }).go?.app?.['VaultCryptoAPI'];
  const unlock = crypto?.['Unlock'];
  if (!crypto || !unlock) return;
  crypto['Unlock'] = async (...args: unknown[]) => {
    const result = await unlock(...args);
    if (args[0] === localId) g.noteUnlocked();
    return result;
  };
}

export async function launchWorkbench(o: LaunchOptions): Promise<Launched> {
  let redirecting = false;
  const getToken = async (): Promise<string> => {
    const user = await o.auth.getUser();
    if (!user) {
      // A page without a cloud (localOnly) has nobody to sign in: the core simply stays disconnected.
      if (!o.localOnly && !redirecting) {
        redirecting = true;
        // The session could not be renewed: the edits are written before the page goes to sign in.
        await flushWorkbench();
        void o.auth.signIn(`${location.pathname}${location.search}`);
      }
      throw new Error('signed out');
    }
    return user.accessToken;
  };

  o.progress('core');
  let started = false;
  let worker: Worker | null = null;
  const core = await startCore({
    assets: o.assets,
    config: {
      dataDir: '/memobrain/data',
      version: o.version,
      logLevel: 'warn',
      ...(o.fsTrace ? { fsTrace: true } : {}),
    },
    getToken,
    onQuit: () => void backToConsole(),
    // Before start-up completes the failure is the error launchWorkbench throws.
    onFatal: () => {
      if (started) showFatal();
    },
    createWorker: () => (worker = createCoreWorker()),
  });
  started = true;
  await core.start();
  installWailsGlobals(core);
  core.domReady();
  // Leaving the page: let the core close its databases (best effort, the page may already be going away).
  window.addEventListener('pagehide', () => void core.shutdown().catch(() => undefined));
  // Ask the browser not to evict the copies under storage pressure (it may still say no).
  void navigator.storage?.persist?.().catch(() => false);

  // Clear text of private vaults left behind by a tab that was closed (best effort: each copy on its own).
  await sweepPrivateCopies((path) => core.wipe(path));

  if (!o.localOnly) {
    // The administrator may have switched the workbench off (feature `web_workbench`): a typed address does not bypass it.
    await waitForSession(core);
    const state = await core.callWithin<{ features?: Record<string, boolean> }>(
      LIMITS.config,
      'ConfigAPI',
      'Effective',
    );
    if (!featureEnabled(state.features, Feature.WebWorkbench)) {
      core.terminate();
      throw new Error(DISABLED);
    }
  }

  let vaultId = o.vaultId;
  if (o.create) {
    if (o.localOnly || !o.mountCreate) throw new Error('creating a vault needs the cloud');
    o.progress('session');
    await waitForSession(core);
    o.progress('vault');
    const created = await runCreation({
      core,
      creation: o.create,
      mount: o.mountCreate,
      replaceUrl: (path) => history.replaceState(null, '', path),
      limits: { open: LIMITS.open, close: LIMITS.close },
    });
    if (!created) {
      goToConsole();
      throw new Error(CANCELLED);
    }
    vaultId = created.vaultId;
    o.progress('vault');
  }

  let info: VaultInfo;
  if (o.share) {
    o.progress('session');
    await waitForSession(core);
    o.progress('vault');
    info = await core.callWithin<VaultInfo>(LIMITS.open, 'SharingAPI', 'OpenMount', o.share);
  } else {
    if (!o.localOnly) {
      o.progress('session');
      await waitForSession(core);
    }
    o.progress('vault');
    // The copy's folder: the one its marker records (a vault created in this browser lives in a
    // `new-…` folder, see create.ts), or the folder named by the cloud id.
    const path = folderOf(vaultId);
    info = await core.callWithin<VaultInfo>(LIMITS.open, 'VaultAPI', 'OpenVault', path);
    if (!o.localOnly) {
      const link = await core.callWithin<LinkInfo>(LIMITS.info, 'SyncAPI', 'Info', info.id);
      if (!link.linked) {
        await core.callWithin(LIMITS.link, 'SyncAPI', 'LinkExisting', info.id, vaultId);
        // The folder is named by cloud id; reopening it shows the name the user gave the vault.
        await core.callWithin(LIMITS.close, 'VaultAPI', 'CloseVault', info.id);
        info = await core.callWithin<VaultInfo>(LIMITS.open, 'VaultAPI', 'OpenVault', path);
      }
    }
  }
  const link = await core
    .callWithin<LinkInfo>(LIMITS.info, 'SyncAPI', 'Info', info.id)
    .catch((): LinkInfo => ({ linked: false }));
  const kind = link.kind ?? '';

  if (!o.localOnly && link.linked) {
    const markerId = o.share ? `share:${o.share}` : vaultId;
    const g = createVaultGuard({
      core,
      markerId,
      info,
      kind,
      flush: flushWorkbench,
      goToConsole,
      reload: () => window.location.reload(),
    });
    guard = g;
    watchUnlock(info.id, g);

    // A private copy with changes that were not uploaded survived a closed tab: it is clear text, so it
    // is unlocked before the workbench shows it.
    const kept = needsGate(markerId, kind, Boolean(link.locked));
    if (kept)
      await showUnlockGate({
        counts: kept,
        unlock: async (secret, recovery) => {
          const mustChange = await core.call<boolean>(
            'VaultCryptoAPI',
            'Unlock',
            info.id,
            secret,
            recovery,
          );
          g.noteUnlocked();
          return Boolean(mustChange);
        },
        setPassphrase: (passphrase) =>
          core.call<void>('VaultCryptoAPI', 'SetPassphrase', info.id, passphrase),
        deleteCopy: () => void g.deleteCopy(),
        backToConsole: goToConsole,
      });
  }

  // The console, about to remove the copies (signing out, "forget this browser"), asks this tab to leave:
  // it uploads, locks and removes what it can, and releases the files.
  onLeaveRequest(() => void backToConsole());

  o.progress('ui');
  const vaultGuard = guard;
  workbench =
    (await o.mount({
      vaultPath: info.path,
      onBackToConsole: () => void backToConsole(),
      ...(vaultGuard ? { onRemoveFromBrowser: () => void vaultGuard.removeCopy() } : {}),
    })) ?? null;
  if (import.meta.env.MEMOBRAIN_E2E) {
    // Playwright drives the core, the worker (to simulate its failure) and the leave path directly.
    Object.assign(window, {
      __core: core,
      __coreWorker: worker,
      __lockAndForget: () => guard?.lockAndForget(),
    });
  }
  return { core, localId: info.id, kind };
}
