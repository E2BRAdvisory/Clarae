// Declarative actions (ADR-0045 §2): the buttons of the panels that are not commands (they act on
// something the panel shows: a mount, the open vault's link, the session) but realize a feature.
// Like a command, an action names its feature of the registry (`feature: FeatureId`) and the
// capabilities of the host it needs; <ActionButton id=… /> (ui/ActionButton.tsx) or useAction()
// hides it where the host lacks them, so no panel tests the platform itself. scripts/parity.mjs
// reads this registry at runtime (commands/parity.test.ts) and applies the rules of the commands:
// every action belongs to a feature that lists it, and a surface that says `yes` offers it.
import type { QueryClient } from '@tanstack/react-query';
import i18next from 'i18next';
import type { CloudMount } from '@clarae/cloud-features/port';
import { api } from '../app/api';
import type { MountRevokedPayload } from '../app/events';
import { lockVault } from '../app/actions';
import { signIn } from '../app/signIn';
import type { FeatureId } from '../parity/features.gen';
import { can, usePlatform, type Capabilities } from '../platform';
import { sharingKeys } from '../sharing/queries';
import { useAppStore } from '../state/store';
import { useSharing } from '../state/sharing';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { settleNotes } from '../workspaces/flush';

type Capability = keyof Capabilities;

/** What the component that shows an action gives it besides its argument. */
export interface ActionContext {
  /** The query client of the tree the action is shown in (lists to refresh). */
  queryClient: QueryClient;
}

/**
 * An action of a panel. `A` is what it acts on (a mount, the open vault's id; `void` for nothing).
 */
export interface Action<A = void, Id extends string = string> {
  /** `<area>:<verb>`, like a command id, and never the id of a command. */
  id: Id;
  /** The feature of the registry the action realizes (shared/parity/features.yaml). */
  feature: FeatureId;
  /** Capabilities of the host the action needs: without one it is not shown. */
  requires?: readonly Capability[];
  /**
   * Capabilities whose absence the action stands for: it is shown only where the host lacks them
   * (the browser's «Download a copy» where a copy cannot be kept as a folder, `detachedCopies`).
   */
  excludes?: readonly Capability[];
  /** i18n key of the button's text (none when a shared component draws its own button). */
  label?: string | ((arg: A) => string);
  /** Whether the action applies to its argument at all (otherwise it is not shown). */
  when?: (arg: A) => boolean;
  /** Whether it can run right now (otherwise the button is disabled). */
  enabled?: (arg: A) => boolean;
  run: (arg: A, ctx: ActionContext) => void | Promise<void>;
}

/** Declares an action; the id stays a literal type, so <ActionButton id=… /> is checked. */
export function defineAction<A = void, const Id extends string = string>(
  action: Action<A, Id>,
): Action<A, Id> {
  return action;
}

/** The host offers what the action needs (`requires`) and lacks what it stands in for (`excludes`). */
export function isActionAvailable(a: Pick<Action<never>, 'requires' | 'excludes'>): boolean {
  return (
    (a.requires ?? []).every((name) => can(name)) && (a.excludes ?? []).every((name) => !can(name))
  );
}

const t = (key: string, opts: Record<string, unknown> = {}): string => i18next.t(key, opts);

async function reportErrors(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    await dialog.error(e);
  }
}

/** Runs a change of the open vault's link, reports a failure and reads the link again. */
async function onLink(vaultId: string, fn: () => Promise<unknown>): Promise<void> {
  await reportErrors(fn);
  await useSync.getState().refresh(vaultId);
}

const refreshMounts = (qc: QueryClient) =>
  void qc.invalidateQueries({ queryKey: sharingKeys.mounts });

// ---- vaults on this computer (the welcome screen, the vault menu) -------------------------------

/** Opens the folder the user picks as a vault, with `open` (the caller's way to open a vault). */
const openFolder = defineAction({
  id: 'vault:open-folder',
  feature: 'vault.local-folder',
  // The browser has cloud vaults only (Host.OpenDirectory fails there).
  requires: ['localFolders'],
  label: 'welcome.openFolder',
  run: async (open: (path: string) => Promise<void>) => {
    const path = await api.vault.pickFolder(t('welcome.pickTitle'));
    if (path) await open(path);
  },
});

// ---- mounts (Settings › Sharing, in the slot of MountsList, and the "share ended" prompt) -------

const openMount = defineAction({
  id: 'mount:open',
  feature: 'mounts',
  label: 'sharing.open',
  when: (m: CloudMount) => !m.local?.revoked,
  run: async (m: CloudMount, { queryClient }) => {
    try {
      // The open vault's pending edits are written before its views go away.
      if (!(await settleNotes())) return;
      const hostOpens = usePlatform.getState().openMount;
      if (hostOpens) {
        // The browser: the host leaves this page for the mount's own.
        hostOpens({ shareId: m.share_id, cloudVaultId: m.vault_id });
        return;
      }
      const info = await api.sharing.openMount(m.share_id);
      useAppStore.getState().setVault(info);
      useAppStore.getState().closeSettings();
      refreshMounts(queryClient);
    } catch (e) {
      await dialog.error(e);
    }
  },
});

const removeMount = defineAction({
  id: 'mount:remove',
  feature: 'mounts',
  label: 'sharing.removeMount',
  when: (m: CloudMount) => Boolean(m.local?.mounted),
  run: async (m: CloudMount, { queryClient }) => {
    const revoked = Boolean(m.local?.revoked);
    const openId = m.local?.open_vault_id ?? '';
    // A copy kept after a revocation is a folder of its own: only where one can be opened again.
    const askKeep = revoked && can('detachedCopies');
    const keep = askKeep
      ? await dialog.confirm(t('sharing.removeMount'), t('sharing.keepCopyQuestion'))
      : false;
    if (
      !askKeep &&
      !(await dialog.confirm(
        t('sharing.removeMount'),
        t('sharing.confirmRemoveMount', { name: m.display_name }),
        true,
      ))
    )
      return;
    const { removeFromBrowser, mountRemoved } = usePlatform.getState();
    const isOpen = openId !== '' && useAppStore.getState().vault?.id === openId;
    if (isOpen && removeFromBrowser) {
      // The mount open in the browser: the host uploads what it can, removes the copy and its
      // marker and goes back to the console, or keeps the copy and asks (D-04).
      useAppStore.getState().closeSettings();
      removeFromBrowser();
      return;
    }
    try {
      await api.sharing.removeMount(m.share_id, keep);
      mountRemoved?.(m.share_id);
      if (isOpen) useAppStore.getState().setVault(null);
      refreshMounts(queryClient);
    } catch (e) {
      await dialog.error(e);
    }
  },
});

/** The answer to the "share ended" prompt: the copy goes, or stays as a vault of its own. */
async function finishRevoked(
  r: MountRevokedPayload,
  keep: boolean,
  queryClient: QueryClient,
): Promise<void> {
  const isOpen = useAppStore.getState().vault?.id === r.vaultId;
  const { removeFromBrowser, mountRemoved } = usePlatform.getState();
  if (!keep && isOpen && removeFromBrowser) {
    // The browser: its host removes the copy and its marker and goes back to the console; what
    // was not uploaded is listed before anything is deleted (D-04).
    useSharing.getState().setRevoked(null);
    removeFromBrowser();
    return;
  }
  try {
    const kept = await api.sharing.removeMount(r.shareId, keep);
    mountRemoved?.(r.shareId);
    if (isOpen) useAppStore.getState().setVault(null);
    refreshMounts(queryClient);
    useSharing.getState().setRevoked(null);
    if (keep && kept.path)
      await dialog.alert(t('sharing.keptTitle'), t('sharing.keptAt', { path: kept.path }));
  } catch (e) {
    await dialog.error(e);
  }
}

const deleteRevokedCopy = defineAction({
  id: 'mount:delete-copy',
  feature: 'mounts',
  label: 'sharing.deleteCopy',
  run: (r: MountRevokedPayload, { queryClient }) => finishRevoked(r, false, queryClient),
});

const keepRevokedCopy = defineAction({
  id: 'mount:keep-copy',
  feature: 'mounts',
  // The copy becomes a folder of its own: only where one can be opened again.
  requires: ['detachedCopies'],
  label: 'sharing.keepCopy',
  run: (r: MountRevokedPayload, { queryClient }) => finishRevoked(r, true, queryClient),
});

const downloadRevokedCopy = defineAction({
  id: 'mount:download-copy',
  feature: 'mounts',
  // Where a kept folder cannot be opened again (the browser): the copy is saved as a ZIP instead.
  excludes: ['detachedCopies'],
  label: 'sharing.downloadCopy',
  // The export reads the open vault.
  when: (r: MountRevokedPayload) => useAppStore.getState().vault?.id === r.vaultId,
  run: (r: MountRevokedPayload) =>
    reportErrors(async () => {
      const res = await api.vault.exportZip(r.vaultId);
      if (res.cancelled) return;
      await dialog.alert(
        t('export.doneTitle'),
        t('export.done', { count: res.files, path: res.path }),
      );
    }),
});

// ---- cloud vaults and the open vault's link (Settings › Cloud, Settings › Sync) ----------------

const newCloudVault = defineAction({
  id: 'cloud-vault:new',
  feature: 'vault.create',
  // A new cloud vault comes from connecting the open folder; in the browser the page is a cloud
  // vault already (a private one is created from the console's creation route).
  requires: ['unlinkVault'],
  when: () => {
    const v = useAppStore.getState().vault;
    return v !== null && !infoOf(useSync.getState(), v.id).linked;
  },
  run: () => {
    useAppStore.getState().closeSettings();
    useSync.getState().setWizardOpen(true);
  },
});

const unlinkVault = defineAction({
  id: 'sync:unlink',
  feature: 'sync.unlink',
  // Where a folder lives without its cloud vault (the desktop).
  requires: ['unlinkVault'],
  label: 'sync.disconnect',
  run: async (vaultId: string) => {
    if (await dialog.confirm(t('sync.disconnect'), t('sync.disconnectText'), true))
      await onLink(vaultId, () => api.sync.unlink(vaultId));
  },
});

/** Why the copy of the open vault is removed: from Settings › Sync, or its cloud vault is gone. */
export type RemoveCopyReason = 'linked' | 'cloud-deleted';

const removeFromBrowser = defineAction({
  id: 'sync:remove-from-browser',
  feature: 'sync.unlink',
  // In the browser the copy belongs to the cloud vault: it is removed where the desktop unlinks.
  excludes: ['unlinkVault'],
  label: 'sync.removeFromBrowser',
  // The host removes the copy (uploading first, D-04) and goes back to the console.
  when: () => usePlatform.getState().removeFromBrowser !== null,
  run: async (reason: RemoveCopyReason) => {
    const remove = usePlatform.getState().removeFromBrowser;
    const text = reason === 'linked' ? 'sync.removeFromBrowserText' : 'sync.removeDeletedCopyText';
    if (remove && (await dialog.confirm(t('sync.removeFromBrowser'), t(text), true))) remove();
  },
});

/** The open vault's link, as Settings › Sync shows it. */
export interface LinkRef {
  vaultId: string;
  paused: boolean;
}

const pauseSync = defineAction({
  id: 'sync:pause',
  feature: 'sync.engine',
  label: (l: LinkRef) => (l.paused ? 'sync.resume' : 'sync.pause'),
  run: (l: LinkRef) => onLink(l.vaultId, () => api.sync.setPaused(l.vaultId, !l.paused)),
});

const lockNow = defineAction({
  id: 'vault:lock',
  feature: 'crypto.unlock',
  label: 'sync.lockNow',
  run: (vaultId: string) => onLink(vaultId, () => lockVault(vaultId)),
});

// ---- the session (Settings › Cloud, Settings › Sync) -------------------------------------------

const signInAction = defineAction({
  id: 'account:sign-in',
  feature: 'account.session',
  // In the browser the session is the page's, managed by the console.
  requires: ['ownsSession'],
  label: 'cloud.login',
  enabled: (serverUrl: string) => serverUrl !== '',
  run: async (serverUrl: string) => {
    useAppStore.getState().setAuth(await signIn(serverUrl)); // a failure is in the state
  },
});

const signOutAction = defineAction({
  id: 'account:sign-out',
  feature: 'account.session',
  requires: ['ownsSession'],
  label: 'cloud.logout',
  run: async () => {
    useAppStore.getState().setAuth(await api.auth.logout());
  },
});

/** Every action, in the order the parity document lists them. */
export const actions = [
  openFolder,
  openMount,
  removeMount,
  deleteRevokedCopy,
  keepRevokedCopy,
  downloadRevokedCopy,
  newCloudVault,
  unlinkVault,
  removeFromBrowser,
  pauseSync,
  lockNow,
  signInAction,
  signOutAction,
] as const;

type AnyAction = (typeof actions)[number];
export type ActionId = AnyAction['id'];
/** What the action `Id` acts on. */
export type ActionArg<Id extends ActionId> =
  Extract<AnyAction, { id: Id }> extends Action<infer A, Id> ? A : never;

const byId = new Map<string, AnyAction>(actions.map((a) => [a.id, a]));

/** The action with this id (typed by the id). */
export function actionById<Id extends ActionId>(id: Id): Action<ActionArg<Id>, Id> {
  const a = byId.get(id);
  if (!a) throw new Error(`unknown action ${id}`);
  return a as unknown as Action<ActionArg<Id>, Id>;
}
