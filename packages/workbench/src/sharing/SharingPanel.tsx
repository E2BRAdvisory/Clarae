// Settings > Sharing (M4-WP4, ADR-0037 §2, ADR-0045 §7): the invitations, the mounts and the shares
// of the account are the components of @memobrain/cloud-features, the same as the console's (the
// status bar's count of invitations reads their cache, sharing/queries.ts). The
// mounts list (MountsList) is the console's too; the workbench puts its own actions in its slot:
// opening and removing a mount are declarative actions (mount:open, mount:remove in
// commands/actions.ts), so in the browser a mount opens in a page of its own and the copy of the
// open one is removed by the host (the platform's hooks), and the web host's guard and markers
// follow every mount.
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeature } from '@memobrain/cloud-features/flags';
import type { CloudMount } from '@memobrain/cloud-features/port';
import '@memobrain/cloud-features/workbench.css';
import { CoreCloudPort } from '../cloud/CoreCloudPort';
import { InvitationsList, MountsList, SharesManager } from '../cloud/lazyPanels';
import { useAppStore } from '../state/store';
import { ActionButton } from '../ui/ActionButton';

function MountActions({ mount }: { mount: CloudMount }) {
  return (
    <>
      <ActionButton id="mount:open" arg={mount} className="nd-button nd-button--small" />
      <ActionButton id="mount:remove" arg={mount} className="nd-button nd-button--small" />
    </>
  );
}

export function SharingPanel() {
  const { t, i18n } = useTranslation();
  const port = useMemo(() => new CoreCloudPort(), []);
  const status = useAppStore((s) => s.auth?.status ?? 'signed_out');
  const signedIn = status === 'ready' || status === 'disconnected';
  const sharingOn = useFeature(port, 'sharing');
  return (
    <div className="sharing-panel">
      {!signedIn && <p className="muted">{t('sharing.signIn')}</p>}
      {signedIn && (
        <>
          <InvitationsList port={port} lang={i18n.language} sections={['pending']} />
          <MountsList
            port={port}
            lang={i18n.language}
            actions={(m) => <MountActions mount={m} />}
          />
        </>
      )}
      {signedIn && sharingOn && (
        <>
          <h3>{t('sharing.mine')}</h3>
          <SharesManager port={port} lang={i18n.language} />
        </>
      )}
    </div>
  );
}
