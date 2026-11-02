import { useQueryClient } from '@tanstack/react-query';
import { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { Events, type MountRevokedPayload } from '../app/events';
import { useManaged, fromState } from '../state/managed';
import { useAppStore } from '../state/store';
import { useSharing } from '../state/sharing';
import { dialog } from '../ui/dialogs';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { lazyView } from '../ui/lazyView';
import { sharingKeys } from './queries';
// Loaded on demand: the dialog (and the share editor of @memobrain/cloud-features) is not needed to
// open a vault.
const ShareDialog = lazyView(async () => ({
  default: (await import('./ShareDialog')).ShareDialog,
}));
import { useSync } from '../state/sync';

/** Mounted once: the share dialog, the "share ended" prompt, and the events behind both. */
export function SharingDialogs() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const vault = useAppStore((s) => s.vault);
  const target = useSharing((s) => s.shareTarget);
  const revoked = useSharing((s) => s.revoked);

  useEffect(() => {
    // The configuration in force applies from the start (cached when offline).
    void useManaged.getState().load();
    const refreshLists = () => {
      void qc.invalidateQueries({ queryKey: ['shares'] });
      // The lists of @memobrain/cloud-features (Settings > Sharing, the share dialog).
      void qc.invalidateQueries({ queryKey: ['cloud-features', 'core', 'shares'] });
    };
    const offs = [
      api.on(Events.sharesChanged, refreshLists),
      api.on(Events.mountsChanged, () => {
        refreshLists();
        const id = useAppStore.getState().vault?.id;
        if (id) void useSync.getState().refresh(id); // a new level changes what the open mount allows
      }),
      api.on<MountRevokedPayload>(Events.mountRevoked, (p) => {
        refreshLists();
        void useSync.getState().refresh(p.vaultId);
        useSharing.getState().setRevoked(p);
      }),
      api.on<Parameters<typeof fromState>[0]>(Events.configUpdated, (s) =>
        useManaged.getState().set(fromState(s)),
      ),
    ];
    return () => offs.forEach((f) => f());
  }, [qc]);

  const finish = async (keep: boolean) => {
    const r = revoked;
    if (!r) return;
    try {
      const kept = await api.sharing.removeMount(r.shareId, keep);
      if (useAppStore.getState().vault?.id === r.vaultId) useAppStore.getState().setVault(null);
      void qc.invalidateQueries({ queryKey: sharingKeys.mounts });
      useSharing.getState().setRevoked(null);
      if (keep && kept.path)
        await dialog.alert(t('sharing.keptTitle'), t('sharing.keptAt', { path: kept.path }));
    } catch (e) {
      await dialog.error(e);
    }
  };

  return (
    <>
      {vault && target && (
        <ErrorBoundary
          scope="dialog"
          resetKey={target.path}
          onClose={() => useSharing.getState().closeShare()}
        >
          <Suspense fallback={null}>
            <ShareDialog key={target.path} vaultId={vault.id} target={target} />
          </Suspense>
        </ErrorBoundary>
      )}
      {revoked && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal wizard"
            role="alertdialog"
            aria-modal="true"
            aria-label={t('sharing.revokedTitle')}
          >
            <h2>{t('sharing.revokedTitle')}</h2>
            <p>{t('sharing.revokedText', { name: revoked.name })}</p>
            <div className="actions">
              <button onClick={() => void finish(false)}>{t('sharing.deleteCopy')}</button>
              <button className="primary" onClick={() => void finish(true)}>
                {t('sharing.keepCopy')}
              </button>
              <button onClick={() => useSharing.getState().setRevoked(null)}>
                {t('sharing.later')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
