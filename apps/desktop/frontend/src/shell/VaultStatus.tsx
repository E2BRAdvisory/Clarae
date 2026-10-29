import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { SyncIndicator } from '../sync/SyncIndicator';
import { UpdateIndicator } from '../updater/UpdateDialog';
import { InvitesIndicator, PermissionBadge } from '../sharing/StatusItems';

/**
 * Index and cloud state of the open vault: permission level, updates, sync, invitations. It sits
 * at the bottom of the right sidebar, or in the header while that sidebar is closed.
 */
export function VaultStatus() {
  const { t } = useTranslation();
  const progress = useAppStore((s) => s.indexProgress);
  const vault = useAppStore((s) => s.vault);
  return (
    <div className="vault-status">
      <PermissionBadge />
      <UpdateIndicator />
      <SyncIndicator />
      <InvitesIndicator />
      {vault && (
        <span className="index-state">
          {progress
            ? t('status.indexing', { done: progress.done, total: progress.total })
            : t('status.indexed')}
        </span>
      )}
    </div>
  );
}
