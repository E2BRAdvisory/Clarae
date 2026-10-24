// Settings > Sharing (M4-WP4): invitations, shares received (mounts) and the ones of the open vault.
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type MountState, type ShareInfo } from '../app/api';
import { useAppStore } from '../state/store';
import { useSharing } from '../state/sharing';
import { dialog } from '../ui/dialogs';
import { sharingKeys, useInvitations, useMounts, useVaultShares } from './queries';
import { infoOf, useSync } from '../state/sync';

function Invitation({ share }: { share: ShareInfo }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: sharingKeys.invitations });
    void qc.invalidateQueries({ queryKey: sharingKeys.mounts });
  };
  const answer = async (accept: boolean) => {
    try {
      if (accept) await api.sharing.accept(share.id);
      else await api.sharing.decline(share.id);
      refresh();
    } catch (e) {
      await dialog.error(e);
    }
  };
  return (
    <li className="invitation">
      <div>
        <strong>{share.displayName}</strong>
        <div className="muted small">
          {t('sharing.invitedBy', { owner: share.ownerName })} ·{' '}
          {t(`sharing.level_${share.myPermission || 'viewer'}`)} ·{' '}
          {t(`sharing.type_${share.resourceType}`)}
        </div>
      </div>
      <div className="actions">
        <button className="primary" onClick={() => void answer(true)}>
          {t('sharing.accept')}
        </button>
        <button onClick={() => void answer(false)}>{t('sharing.decline')}</button>
      </div>
    </li>
  );
}

function Mount({ mount }: { mount: MountState }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const setVault = useAppStore((s) => s.setVault);
  const refresh = () => void qc.invalidateQueries({ queryKey: sharingKeys.mounts });
  const open = async () => {
    try {
      const info = await api.sharing.openMount(mount.shareId);
      setVault(info);
      useAppStore.getState().closeSettings();
      refresh();
    } catch (e) {
      await dialog.error(e);
    }
  };
  const remove = async () => {
    const keep = mount.revoked
      ? await dialog.confirm(t('sharing.removeMount'), t('sharing.keepCopyQuestion'))
      : false;
    if (
      !mount.revoked &&
      !(await dialog.confirm(
        t('sharing.removeMount'),
        t('sharing.confirmRemoveMount', { name: mount.name }),
        true,
      ))
    )
      return;
    try {
      await api.sharing.removeMount(mount.shareId, keep);
      if (mount.vaultId && useAppStore.getState().vault?.id === mount.vaultId)
        useAppStore.getState().setVault(null);
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
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const info = useSync((s) => infoOf(s, vault?.id));
  const { data: invitations = [] } = useInvitations();
  const { data: mounts = [] } = useMounts();
  const canShare = !!vault && info.linked && info.kind === 'shared' && !info.mount;
  const { data: mine = [] } = useVaultShares(vault?.id, canShare);
  return (
    <div className="sharing-panel">
      <h3>{t('sharing.invitations')}</h3>
      {invitations.length === 0 ? (
        <p className="muted">{t('sharing.noInvitations')}</p>
      ) : (
        <ul className="share-list">
          {invitations.map((s) => (
            <Invitation key={s.id} share={s} />
          ))}
        </ul>
      )}
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
      <h3>{t('sharing.mine')}</h3>
      {!canShare ? (
        <p className="muted">{t('sharing.cannotShareHere')}</p>
      ) : (
        <>
          {mine.length === 0 && <p className="muted">{t('sharing.noShares')}</p>}
          <ul className="share-list">
            {mine.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>{s.displayName}</strong>
                  <div className="muted small">
                    {t(`sharing.type_${s.resourceType}`)}
                    {s.pathPrefix ? ` · ${s.pathPrefix}` : ''} ·{' '}
                    {t('sharing.recipientsCount', { count: s.grants.length })}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <button onClick={() => useSharing.getState().openShare({ path: '', isDir: true })}>
            {t('sharing.shareWholeVault')}
          </button>
        </>
      )}
    </div>
  );
}
