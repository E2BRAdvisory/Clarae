// Settings > Sharing (M4-WP4, ADR-0037 §2): the invitations and the shares of the account come from
// @memobrain/cloud-features, the same components as the console's; the mounts (the shares received
// as folders on this device, opened and removed here) are the desktop's own. In the browser a mount
// opens in a page of its own and the copy of the open one is removed by the host (the platform's
// hooks), so the web host's guard and markers follow every mount.
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFeature } from '@memobrain/cloud-features/flags';
import '@memobrain/cloud-features/workbench.css';
import { api, type MountState } from '../app/api';
import { useCan, usePlatform } from '../platform';
import { CoreCloudPort } from '../cloud/CoreCloudPort';
import { InvitationsList, SharesManager } from '../cloud/lazyPanels';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { settleNotes } from '../workspaces/flush';
import { sharingKeys, useMounts } from './queries';

function Mount({ mount }: { mount: MountState }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setVault = useAppStore((s) => s.setVault);
  const keepsCopies = useCan('detachedCopies');
  const refresh = () => void qc.invalidateQueries({ queryKey: sharingKeys.mounts });
  const open = async () => {
    try {
      // The open vault's pending edits are written before its views go away.
      if (!(await settleNotes())) return;
      const openMount = usePlatform.getState().openMount;
      if (openMount) {
        // The browser: the host leaves this page for the mount's own.
        openMount({ shareId: mount.shareId, cloudVaultId: mount.cloudVaultId });
        return;
      }
      const info = await api.sharing.openMount(mount.shareId);
      setVault(info);
      useAppStore.getState().closeSettings();
      refresh();
    } catch (e) {
      await dialog.error(e);
    }
  };
  const remove = async () => {
    // A copy kept after a revocation is a folder of its own: only where one can be opened again.
    const askKeep = mount.revoked && keepsCopies;
    const keep = askKeep
      ? await dialog.confirm(t('sharing.removeMount'), t('sharing.keepCopyQuestion'))
      : false;
    if (
      !askKeep &&
      !(await dialog.confirm(
        t('sharing.removeMount'),
        t('sharing.confirmRemoveMount', { name: mount.name }),
        true,
      ))
    )
      return;
    const { removeFromBrowser, mountRemoved } = usePlatform.getState();
    const isOpen = Boolean(mount.vaultId) && useAppStore.getState().vault?.id === mount.vaultId;
    if (isOpen && removeFromBrowser) {
      // The mount open in the browser: the host uploads what it can, removes the copy and its
      // marker and goes back to the console, or keeps the copy and asks (D-04).
      useAppStore.getState().closeSettings();
      removeFromBrowser();
      return;
    }
    try {
      await api.sharing.removeMount(mount.shareId, keep);
      mountRemoved?.(mount.shareId);
      if (isOpen) useAppStore.getState().setVault(null);
      refresh();
    } catch (e) {
      await dialog.error(e);
    }
  };
  return (
    <li className={`mount ${mount.revoked ? 'revoked' : ''}`}>
      <div>
        <strong>{mount.name}</strong>
        <div className="muted small">
          {t('sharing.from', { owner: mount.ownerName })} · {t(`sharing.level_${mount.permission}`)}
          {mount.revoked ? ` · ${t('sharing.revokedShort')}` : ''}
        </div>
      </div>
      <div className="actions">
        {!mount.revoked && <button onClick={() => void open()}>{t('sharing.open')}</button>}
        {mount.mounted && <button onClick={() => void remove()}>{t('sharing.removeMount')}</button>}
      </div>
    </li>
  );
}

export function SharingPanel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const port = useMemo(() => new CoreCloudPort(), []);
  const status = useAppStore((s) => s.auth?.status ?? 'signed_out');
  const signedIn = status === 'ready' || status === 'disconnected';
  const sharingOn = useFeature(port, 'sharing');
  const { data: mounts = [] } = useMounts(sharingOn);
  const refreshInvitations = () => {
    void qc.invalidateQueries({ queryKey: sharingKeys.invitations });
    void qc.invalidateQueries({ queryKey: sharingKeys.mounts });
  };
  return (
    <div className="sharing-panel">
      {!signedIn && <p className="muted">{t('sharing.signIn')}</p>}
      {signedIn && (
        <InvitationsList
          port={port}
          lang={i18n.language}
          sections={['pending']}
          onAnswered={refreshInvitations}
        />
      )}
      {sharingOn && (
        <>
          <h3>{t('sharing.sharedWithMe')}</h3>
          {mounts.length === 0 ? (
            <p className="muted">{t('sharing.noMounts')}</p>
          ) : (
            <ul className="share-list">
              {mounts.map((m) => (
                <Mount key={m.shareId} mount={m} />
              ))}
            </ul>
          )}
          {signedIn && (
            <>
              <h3>{t('sharing.mine')}</h3>
              <SharesManager port={port} lang={i18n.language} />
            </>
          )}
        </>
      )}
    </div>
  );
}
