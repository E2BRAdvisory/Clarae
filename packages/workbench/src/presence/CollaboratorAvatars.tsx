// The people who have the file in front open too, in the toolbar of the explorer (ADR-0065): their avatars, up to
// four and a `+N` for the rest. Nothing is drawn when there is nobody else, when the host or the profile has
// presence off, or when the vault is not a shared one.
import { Avatar, AvatarGroup } from '@clarae/ui';
import { useTranslation } from 'react-i18next';
import { selectActivePath, useAppStore } from '../state/store';
import { getUserColor } from './colors';
import { useMembers } from './store';
import { usePresenceEnabled } from './watch';

/** How many avatars are shown before the `+N`. */
export const MAX_AVATARS = 4;

export function CollaboratorAvatars({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const enabled = usePresenceEnabled(vaultId);
  const path = useAppStore(selectActivePath);
  const members = useMembers(vaultId, path ?? '');
  if (!enabled || !path || members.length === 0) return null;
  return (
    <AvatarGroup
      className="presence-avatars"
      label={t('presence.collaborators')}
      max={MAX_AVATARS}
      spacing="small"
      moreLabel={(count, names) => t('presence.more', { count, names: names.join(', ') })}
    >
      {members.map((m) => {
        const color = getUserColor(m.userId);
        return (
          <Avatar
            key={m.sid}
            name={m.name}
            color={color.background}
            textColor={color.foreground}
            data-user={m.userId}
            data-color={color.index}
            data-testid="presence-avatar"
          />
        );
      })}
    </AvatarGroup>
  );
}
