/**
 * Opens a cloud vault in the browser: starts the Go core, links the vault to this browser as a device
 * (the same flow as "link an existing vault" on the desktop), and mounts the desktop UI on top of it.
 *
 * What the browser keeps of a private vault is clear text, so it does not outlive the session
 * (ADR-0029 §6): the core locks the vault (manually or after the idle time it is configured with) and the
 * guard (guard.ts) then removes the copy; a copy left behind by a closed tab is removed by the sweep at the
 * next start. Copies with changes not uploaded yet are never removed without asking (D-04).
 *
 * Everything the workbench keeps belongs to the signed-in account (storage.ts): its own folders, markers
 * and device registration. The copies an earlier version kept for everyone are adopted only by the
 * account shown to own them all, and never opened otherwise.
 */
import { Feature, featureEnabled } from '@memobrain/api-client/features';
import type { AuthService } from '../auth/types';
import {
  CoreTimeoutError,
  createCoreWorker,
  installWailsGlobals,
  startCore,
  type CoreHandle,
} from './bridge';
import { coreClient, type BindingHooks } from './core.gen';
import { VAULTS_DIR, folderOf, runCreation, type Creation, type MountCreate } from './create';
import { legacyDeviceUser } from './device';
import { onLeaveRequest } from './forget';
import { createVaultGuard, needsGate, type VaultGuard } from './guard';
import { removeMarker, sweepPrivateCopies } from './markers';
import { workbenchHref } from '../shared/routes';
import { LOCAL_SUBJECT, accountKey, adoptLegacyCopies, storageOf, type CloudView } from './storage';
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
    /** "Open" of a mount in Settings › Sharing: its own page (openMountPage). */
    onOpenMount: (mount: { shareId: string; cloudVaultId: string }) => void;
    /** A mount's copy removed from Settings › Sharing: its marker goes too. */
    onMountRemoved: (shareId: string) => void;
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
 * in a loading screen forever. Opening and linking index the vault, hence the generous limits; loading
 * the core (the WebAssembly, the storage) and its OnStartup too. A removal of the sweep that takes
 * longer is left running and the sweep stops waiting; unlocking derives a key with Argon2id, slow on a
 * weak computer.
 */
export const LIMITS = {
  ready: 120_000,
  start: 120_000,
  wipe: 120_000,
  status: 10_000,
  config: 30_000,
  info: 30_000,
  open: 180_000,
  link: 180_000,
  close: 60_000,
  unlock: 180_000,
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

/**
 * Opens the mount of a received share (Settings › Sharing): the browser holds one vault per page, so
 * this page leaves as it does for the console (edits written and uploaded, a private copy locked and
 * removed) and loads the mount's own page, the address the console opens too. Its launch creates the
 * guard and the marker of the mount; switching vault inside this page would bypass both.
 */
export async function openMountPage(mount: {
  shareId: string;
  cloudVaultId: string;
}): Promise<void> {
  const href = workbenchHref(mount.cloudVaultId, { share: mount.shareId });
  const go = (): void => window.location.assign(href);
  if (guard) return guard.leave(go);
  await flushWorkbench();
  go();
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

/** The core's bindings with a time limit (the typed client generated in core.gen.ts). */
const within = (core: CoreHandle, ms: number) => coreClient(core, ms);

/**
 * What the cloud says the account can reach, for adopting the copies of an earlier version
 * (storage.ts ownsLegacy). Read with the page's own token, before the core starts.
 */
async function fetchCloudView(
  token: string,
  need: { vaults: boolean; shares: boolean },
): Promise<CloudView> {
  const get = async (path: string, optional = false): Promise<unknown> => {
    const res = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
    // Sharing turned off for the account: it has no share to prove anything with.
    if (optional && (res.status === 403 || res.status === 404)) return [];
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const me = (await get('/me')) as { id?: string };
  if (!me.id) throw new Error('GET /me: no user id');
  const vaults = need.vaults
    ? (((await get('/vaults?include_deleted=true')) as { items?: { id: string }[] }).items ?? [])
    : [];
  const shares = need.shares
    ? ((await get('/shares?scope=received', true)) as { id: string }[])
    : [];
  return {
    userId: me.id,
    vaultIds: new Set(vaults.map((v) => v.id)),
    shareIds: new Set(Array.isArray(shares) ? shares.map((s) => s.id) : []),
  };
}

/** Waits until the core has a cloud session (it asks the page for a token and loads the profile). */
async function waitForSession(core: CoreHandle, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: AuthState = { status: 'unknown' };
  while (Date.now() < deadline) {
    last = await within(core, LIMITS.status).AuthAPI.Status();
    if (last.status === 'ready') return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no cloud session (${last.status}${last.error ? `: ${last.error}` : ''})`);
}

/**
 * Observers of the UI's own calls of the bindings (installWailsGlobals reads them at each call, so the
 * guard's is added once it exists).
 */
const bindingHooks: BindingHooks = {};

/** Tells the guard when the workbench's own unlock dialog unlocked the vault (window.go is what it calls). */
function watchUnlock(localId: string, g: VaultGuard): void {
  bindingHooks.VaultCryptoAPI = {
    Unlock: ([vaultId]) => {
      if (vaultId === localId) g.noteUnlocked();
    },
  };
}

/** The error launchWorkbench throws when the copy to open is the one a slow removal is still deleting. */
export const STILL_REMOVING =
  'the copy of this vault left by an earlier session is still being removed: try again in a moment';

/**
 * The start-up sweep (sweepPrivateCopies) with a limit on each removal. Resolves to the folder whose
 * removal did not finish in time (the core goes on with it), or null; after one such removal the
 * remaining copies are left for the next start.
 */
export async function sweepWithin(
  account: string,
  core: CoreHandle,
  limitMs: number,
): Promise<string | null> {
  let stuck: string | null = null;
  await sweepPrivateCopies(account, async (path) => {
    if (stuck !== null) throw new Error('skipped: an earlier removal is still running');
    try {
      await core.wipe(path, limitMs);
    } catch (e) {
      if (e instanceof CoreTimeoutError) stuck = path;
      throw e;
    }
  });
  return stuck;
}

export async function launchWorkbench(o: LaunchOptions): Promise<Launched> {
  // The account this page works for, and its storage (storage.ts). A page without a cloud
  // (`?local`, E2E builds only) uses the signed-in test user when there is one.
  const signedIn = await o.auth.getUser().catch(() => null);
  if (!signedIn && !o.localOnly) throw new Error('signed out');
  const server = location.origin;
  const subject = signedIn?.sub ?? LOCAL_SUBJECT;
  const account = await accountKey({ server, subject });
  if (!o.localOnly && signedIn) {
    const adoption = await adoptLegacyCopies({
      key: account,
      server,
      deviceUserId: () => legacyDeviceUser(server),
      cloud: (need) => fetchCloudView(signedIn.accessToken, need),
    });
    if (adoption === 'unproven' || adoption === 'kept')
      console.info(
        'memobrain: the vault copies of an earlier version stay unopened (they cannot be shown to belong to this account)',
      );
  }
  const storage = await storageOf(account);

  let redirecting = false;
  let switched = false;
  const getToken = async (): Promise<string> => {
    // An identity provider that cannot be reached rejects here (the session is kept): the core gets an
    // error, its sync waits and tries again, and the page does not go to sign in.
    // A page without a cloud never signs the core in, even with a test user signed in.
    if (o.localOnly) throw new Error('signed out');
    const user = await o.auth.getUser();
    if (user && user.sub !== subject) {
      // Another account signed in meanwhile (another tab): this page holds the first account's
      // copies and must not work on them with the other's token. Its edits are written, then it
      // goes back to the console, which starts over with the new account.
      if (!switched) {
        switched = true;
        await flushWorkbench();
        goToConsole();
      }
      throw new Error('signed out');
    }
    if (!user) {
      if (!redirecting) {
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
      storage: { fs: storage.fs, sqlite: storage.sqlite },
      account: subject,
    },
    getToken,
    onQuit: () => void backToConsole(),
    // Before start-up completes the failure is the error launchWorkbench throws.
    onFatal: () => {
      if (started) showFatal();
    },
    createWorker: () => (worker = createCoreWorker()),
    readyTimeoutMs: LIMITS.ready,
  });
  started = true;
  try {
    await core.start(LIMITS.start);
  } catch (e) {
    // A core stuck in its start-up is of no use: stop it so the error page is the end of it.
    core.terminate();
    throw e;
  }
  installWailsGlobals(core, window, bindingHooks);
  core.domReady();
  // Leaving the page: let the core close its databases (best effort, the page may already be going away).
  window.addEventListener('pagehide', () => void core.shutdown().catch(() => undefined));
  // Ask the browser not to evict the copies under storage pressure (it may still say no).
  void navigator.storage?.persist?.().catch(() => false);

  // Clear text of private vaults left behind by a tab that was closed (best effort: each copy on its own).
  // A removal that does not end in time goes on in the core while the page moves on; the sweep stops
  // there (the next ones would queue behind it), and that copy must not be opened meanwhile (below).
  const stuck = await sweepWithin(account, core, LIMITS.wipe);

  if (!o.localOnly) {
    // The administrator may have switched the workbench off (feature `web_workbench`): a typed address does not bypass it.
    await waitForSession(core);
    const state: { features?: Record<string, boolean> } = await within(
      core,
      LIMITS.config,
    ).ConfigAPI.Effective();
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
      account,
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
    info = await within(core, LIMITS.open).SharingAPI.OpenMount(o.share);
  } else {
    if (!o.localOnly) {
      o.progress('session');
      await waitForSession(core);
    }
    o.progress('vault');
    // The copy's folder: the one its marker records (a vault created in this browser lives in a
    // `new-…` folder, see create.ts), or the folder named by the cloud id.
    const path = folderOf(account, vaultId);
    if (stuck === path) throw new Error(STILL_REMOVING);
    info = await within(core, LIMITS.open).VaultAPI.OpenVault(path);
    if (!o.localOnly) {
      const link: LinkInfo = await within(core, LIMITS.info).SyncAPI.Info(info.id);
      if (!link.linked) {
        await within(core, LIMITS.link).SyncAPI.LinkExisting(info.id, vaultId);
        // The folder is named by cloud id; reopening it shows the name the user gave the vault.
        await within(core, LIMITS.close).VaultAPI.CloseVault(info.id);
        info = await within(core, LIMITS.open).VaultAPI.OpenVault(path);
      }
    }
  }
  const link: LinkInfo = await within(core, LIMITS.info)
    .SyncAPI.Info(info.id)
    .catch((): LinkInfo => ({ linked: false }));
  const kind = link.kind ?? '';

  if (!o.localOnly && link.linked) {
    const markerId = o.share ? `share:${o.share}` : vaultId;
    const g = createVaultGuard({
      core,
      account,
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
    const kept = needsGate(account, markerId, kind, Boolean(link.locked));
    if (kept)
      await showUnlockGate({
        counts: kept,
        unlock: async (secret, recovery) => {
          const mustChange = await within(core, LIMITS.unlock).VaultCryptoAPI.Unlock(
            info.id,
            secret,
            recovery,
          );
          g.noteUnlocked();
          return Boolean(mustChange);
        },
        setPassphrase: (passphrase) =>
          within(core, LIMITS.unlock).VaultCryptoAPI.SetPassphrase(info.id, passphrase),
        deleteCopy: () => void g.deleteCopy(),
        backToConsole: goToConsole,
      });
  }

  // The console, about to remove the account's copies (signing out, "forget this browser"), asks this
  // tab to leave: it uploads, locks and removes what it can, and releases the files. After the account
  // was deleted nothing can be uploaded: the engine stops at once (`discard`). Requests about another
  // account's copies are not for this tab.
  onLeaveRequest(account, (discard) => {
    if (!discard) return void backToConsole();
    core.terminate();
    goToConsole();
  });

  o.progress('ui');
  const vaultGuard = guard;
  workbench =
    (await o.mount({
      vaultPath: info.path,
      onBackToConsole: () => void backToConsole(),
      ...(vaultGuard ? { onRemoveFromBrowser: () => void vaultGuard.removeCopy() } : {}),
      onOpenMount: (mount) => void openMountPage(mount),
      // The copy of a mount closed in this page (the open one goes through the guard).
      onMountRemoved: (shareId) => removeMarker(account, `share:${shareId}`),
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
