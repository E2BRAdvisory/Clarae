// Settings > Sharing (M4-WP4, ADR-0037 §2): the invitations and the shares of the account come from
// @memobrain/cloud-features, the same components as the console's; the mounts (the shares received
// as folders on this device, opened and removed here) are the desktop's own. Opening and removing
// one are actions (mount:open, mount:remove in commands/actions.ts): in the browser a mount opens in
// a page of its own and the copy of the open one is removed by the host (the platform's hooks), so
// the web host's guard and markers follow every mount.
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFeature } from '@memobrain/cloud-features/flags';
import '@memobrain/cloud-features/workbench.css';
import type { MountState } from '../app/api';
import { CoreCloudPort } from '../cloud/CoreCloudPort';
import { InvitationsList, SharesManager } from '../cloud/lazyPanels';
import { useAppStore } from '../state/store';
import { ActionButton } from '../ui/ActionButton';
import { sharingKeys, useMounts } from './queries';

function Mount({ mount }: { mount: MountState }) {
  const { t } = useTranslation();
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
        <ActionButton id="mount:open" arg={mount} />
        <ActionButton id="mount:remove" arg={mount} />
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
