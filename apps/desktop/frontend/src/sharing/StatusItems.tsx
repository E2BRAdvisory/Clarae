import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { featureOn, useManaged } from '../state/managed';
import { infoOf, useSync } from '../state/sync';
import { useInvitations } from './queries';

/** Status bar: how many invitations wait for an answer. */
export function InvitesIndicator() {
  const { t } = useTranslation();
  const sharingOn = useManaged((m) => featureOn(m.features, 'sharing'));
  const { data = [] } = useInvitations(sharingOn);
  if (!sharingOn || data.length === 0) return null;
  return (
    <button
      className="icon sync-indicator invites"
      title={t('sharing.invitations')}
      onClick={() => useAppStore.getState().openSettings('sharing')}
    >
      ✉ {t('sharing.invitesN', { count: data.length })}
    </button>
  );
}

/** Status bar: the level held on a mount, and that it is read-only for a viewer. */
export function PermissionBadge() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const info = useSync((s) => infoOf(s, vault?.id));
  if (!vault || !info.linked || !info.mount) return null;
  const label = info.revoked
    ? t('sharing.revokedShort')
    : `${t(`sharing.level_${info.permission || 'viewer'}`)}${info.readOnly ? ` · ${t('sharing.readOnly')}` : ''}`;
  return (
    <span
      className={`badge permission ${info.readOnly ? 'read-only' : ''}`}
      title={t('sharing.from', { owner: info.ownerName })}
    >
      {label}
    </span>
  );
}
