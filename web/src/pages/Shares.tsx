import { useTranslation } from 'react-i18next';
import { InvitationsList, SharesManager } from '@clarae/cloud-features';
import { useFeatureFlag } from '@clarae/cloud-features';
import { useCloudPort } from '../api/cloud';
import { useWorkbenchAllowed } from '../api/queries';

/** An accepted share opens in the browser workbench as a mount (`?share=`). */
export function mountHref(vaultId: string, shareId: string): string {
  return `/vaults/${encodeURIComponent(vaultId)}/open?share=${encodeURIComponent(shareId)}`;
}

/**
 * Sharing: the invitations and shares received, and the shares created or managed by the user, with
 * the components of @clarae/cloud-features (ADR-0037 §2). The `sharing` flag of the effective
 * configuration turns the page off, as it does in the workbench.
 */
export function SharesPage() {
  const { t, i18n } = useTranslation();
  const port = useCloudPort();
  // Until the configuration answers, the components wait (they fetch nothing that sharing gates).
  const sharing = useFeatureFlag(port, 'sharing');
  const canOpen = useWorkbenchAllowed();
  return (
    <>
      <h1>{t('shares.title')}</h1>
      {sharing.on || !sharing.ready ? (
        <div className="nd-stack">
          <section aria-labelledby="shares-received">
            <h2 id="shares-received">{t('shares.received')}</h2>
            <InvitationsList
              port={port}
              lang={i18n.language}
              openHref={canOpen ? (m) => mountHref(m.vault_id, m.share_id) : undefined}
            />
          </section>
          <section aria-labelledby="shares-owned">
            <h2 id="shares-owned">{t('shares.owned')}</h2>
            <SharesManager port={port} lang={i18n.language} />
          </section>
        </div>
      ) : (
        // Says that the administrator turned sharing off.
        <SharesManager port={port} lang={i18n.language} />
      )}
    </>
  );
}
