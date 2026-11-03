import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type AuthState, type SyncStatus } from './api';
import {
  Events,
  type IndexProgressPayload,
  type OpenRequestPayload,
  type SyncConflictPayload,
  type VaultCloudDeletedPayload,
  type VaultLockedPayload,
} from './events';
import { applyTheme, type Theme } from './theme';
import { i18next, initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { applyAppearance, useSettings } from '../state/settings';
import { useInvalidate } from '../state/queries';
import { CommandPalette } from '../commands/CommandPalette';
import { QuickSwitcher } from '../commands/QuickSwitcher';
import { commandForEvent } from '../commands/registry';
import { DialogHost, dialog } from '../ui/dialogs';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { openVaultAt } from './actions';
import { installModalFocus } from '@memobrain/ui';
import { infoOf, useSync } from '../state/sync';
import { SyncDialogs } from '../sync/SyncDialogs';
import { useRecovery } from '../recovery/store';
import { SharingDialogs } from '../sharing/SharingDialogs';
import { useImporter } from '../importer/store';
import { LazyDialog } from '../ui/LazyDialog';
import { lazyView } from '../ui/lazyView';
import { UpdateDialog } from '../updater/UpdateDialog';
import { SlideShow } from '../slides/SlideShow';
import { Header } from '../shell/Header';
import { DeviceRevokedBanner } from '../sync/DeviceRevokedBanner';
import { VaultView } from '../shell/VaultView';
import { Welcome } from '../shell/Welcome';
import { can, useCan, usePlatform } from '../platform';
import { followLinkPath } from './open';
import { applyVaultChanges, onVaultChanges } from './fileChanges';

// The import wizard, the settings and the file recovery are fetched the first time they open: they
// stay out of the startup bundle (ADR-0020).
const ImportWizardDialog = lazyView(async () => ({
  default: (await import('../importer/ImportWizard')).ImportWizardDialog,
}));
const SettingsPanel = lazyView(async () => ({
  default: (await import('../settings/SettingsPanel')).SettingsPanel,
}));
const RecoveryDialogs = lazyView(async () => ({
  default: (await import('../recovery/RecoveryDialog')).RecoveryDialogs,
}));

function ImportWizardGate() {
  const open = useImporter((s) => s.open);
  if (!open) return null;
  return (
    <LazyDialog onClose={() => useImporter.getState().hide()}>
      <ImportWizardDialog />
    </LazyDialog>
  );
}

function SettingsGate() {
  const open = useAppStore((s) => s.settingsOpen);
  if (!open) return null;
  return (
    <LazyDialog onClose={() => useAppStore.getState().closeSettings()}>
      <SettingsPanel />
    </LazyDialog>
  );
}

function RecoveryGate() {
  const open = useRecovery((s) => s.target !== null);
  if (!open) return null;
  return (
    <LazyDialog onClose={() => useRecovery.getState().close()}>
      <RecoveryDialogs />
    </LazyDialog>
  );
}

export function App() {
  const vault = useAppStore((s) => s.vault);
  const updater = useCan('updater');
  const setSettings = useAppStore((s) => s.setSettings);
  const setAuth = useAppStore((s) => s.setAuth);
  const setIndexProgress = useAppStore((s) => s.setIndexProgress);
  const appearance = useSettings((s) => s.appearance);
  const invalidate = useInvalidate();
  const queryClient = useQueryClient();

  // Load preferences once.
  useEffect(() => {
    void api.settings.get().then((s) => {
      setSettings(s);
      applyTheme((s.theme || 'system') as Theme);
      initI18n(s.language || undefined);
    });
  }, [setSettings]);

  useEffect(() => applyAppearance(appearance), [appearance]);

  // Every aria-modal dialog traps Tab and gives focus back to its opener on close (one handler for
  // the page, shared with the Dialog of @memobrain/ui used by the cloud panels: ADR-0043).
  useEffect(() => installModalFocus(), []);

  // Cloud session: initial state, then pushed updates.
  useEffect(() => {
    void api.auth.status().then(setAuth);
    return api.on<AuthState>(Events.authState, setAuth);
  }, [setAuth]);

  // The Web UI opens one vault per page: the host names it, the app opens it once it can listen.
  useEffect(() => {
    const path = usePlatform.getState().initialVault;
    if (path) void openVaultAt(path);
  }, []);

  // Backend events.
  useEffect(() => {
    // File changes are coalesced and patched into the caches (see fileChanges.ts).
    const offFile = onVaultChanges((batch) => applyVaultChanges(queryClient, batch));
    const offIndex = api.on<IndexProgressPayload>(Events.indexProgress, (p) => {
      setIndexProgress(p.finished ? null : p);
      if (p.finished) {
        void invalidate.search(p.vaultId);
        void invalidate.tags(p.vaultId);
        void invalidate.propkeys(p.vaultId);
      }
    });
    return () => {
      offFile();
      offIndex();
    };
  }, [invalidate, queryClient, setIndexProgress]);

  const openVault = async (path: string) => {
    await openVaultAt(path);
    await invalidate.recent();
  };

  // Cloud synchronization: status and conflicts are pushed by the backend.
  useEffect(() => {
    const offStatus = api.on<SyncStatus>(Events.syncStatus, (s) => useSync.getState().setStatus(s));
    const offConflict = api.on<SyncConflictPayload>(
      Events.syncConflict,
      (p) => void useSync.getState().refreshConflicts(p.vaultId),
    );
    const offLocked = api.on<VaultLockedPayload>(Events.vaultLocked, (p) => {
      if (p.vaultId === useAppStore.getState().vault?.id) useSync.getState().setUnlockOpen(true);
    });
    // The cloud vault was deleted from the console or another device: the core disconnected the
    // folder (its files stay). Said once, then Settings > Sync keeps a note of it.
    const offDeleted = api.on<VaultCloudDeletedPayload>(Events.vaultCloudDeleted, (p) => {
      useSync.getState().cloudVaultDeleted(p);
      const name = useSync.getState().cloudDeleted[p.vaultId] ?? p.name;
      const title = i18next.t('sync.cloudDeletedTitle');
      // The desktop connects the folder again. In the browser the copy belongs to the deleted cloud
      // vault: its host offers to remove it (and forgets its marker), or it stays until restored.
      const remove = usePlatform.getState().removeFromBrowser;
      if (!can('unlinkVault') && remove && p.vaultId === useAppStore.getState().vault?.id) {
        void dialog
          .confirm(title, i18next.t('sync.cloudDeletedAskWeb', { name }), true)
          .then((yes) => yes && remove());
        return;
      }
      const text = can('unlinkVault') ? 'sync.cloudDeletedText' : 'sync.cloudDeletedTextWeb';
      void dialog.alert(title, i18next.t(text, { name }));
    });
    return () => {
      offStatus();
      offConflict();
      offLocked();
      offDeleted();
    };
  }, []);

  const vaultId = vault?.id;
  const syncInfo = useSync((s) => infoOf(s, vaultId));
  useEffect(() => {
    if (vaultId) void useSync.getState().refresh(vaultId);
  }, [vaultId]);
  useEffect(() => {
    if (syncInfo.linked && syncInfo.kind === 'private') void useSync.getState().checkDisk();
    if (syncInfo.linked && syncInfo.locked) useSync.getState().setUnlockOpen(true);
  }, [syncInfo.linked, syncInfo.kind, syncInfo.locked]);

  // memobrain://open?vault=…&file=… (from the OS or another instance).
  useEffect(
    () =>
      api.on<OpenRequestPayload>(Events.openRequest, (p) => {
        void followLinkPath(p, openVault);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Application hotkeys. Editors handle theirs first (they call preventDefault).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const c = commandForEvent(e, useSettings.getState().hotkeys);
      if (!c) return;
      e.preventDefault();
      void c.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell">
      <Header />
      <DeviceRevokedBanner />
      {/* The header stays usable (vault menu, account) when the vault view fails. */}
      <ErrorBoundary scope="view" resetKey={vault?.id}>
        {vault ? <VaultView key={vault.id} vaultId={vault.id} /> : <Welcome onOpen={openVault} />}
      </ErrorBoundary>
      <SettingsGate />
      <SyncDialogs />
      <RecoveryGate />
      <SharingDialogs />
      <ImportWizardGate />
      {updater && <UpdateDialog />}
      <CommandPalette />
      <QuickSwitcher />
      <SlideShow />
      <DialogHost />
    </div>
  );
}
