import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { signIn } from '../app/signIn';
import { useAppStore } from '../state/store';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { reregisterDevice } from '../sync/DeviceRevokedBanner';
import { Icon } from './icons';

/** "Ada Lovelace" -> "AL"; a single word gives its first two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters =
    words.length === 1
      ? Array.from(words[0] as string).slice(0, 2)
      : [Array.from(words[0] as string)[0], Array.from(words[words.length - 1] as string)[0]];
  return letters.join('').toUpperCase();
}

/**
 * The cloud account in the ribbon: the avatar of the signed-in user (menu: account and devices,
 * sign out), or a login button (the OIDC flow runs in the system browser: no credentials here).
 */
export function AccountButton() {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const status = auth?.status ?? 'signed_out';

  const login = async (): Promise<void> => {
    const info = await api.settings.info().catch((): Record<string, string> => ({}));
    const server = auth?.serverUrl || info['defaultServer'] || '';
    if (!server) {
      useAppStore.getState().openSettings('cloud'); // the address is asked for there
      return;
    }
    const next = await signIn(server);
    setAuth(next);
    // The reason of a failure is shown in Settings > Cloud, with the address to correct.
    if (next.status === 'signed_out' && next.error) useAppStore.getState().openSettings('cloud');
  };

  if (status === 'signing_in') {
    return (
      <button
        className="icon account"
        disabled
        title={t('cloud.signingIn')}
        aria-label={t('cloud.signingIn')}
      >
        <Icon name="user" />
      </button>
    );
  }

  if (status === 'signed_out') {
    return (
      <button
        className="icon account"
        title={t('account.login')}
        aria-label={t('account.login')}
        onClick={() => void login()}
      >
        <Icon name="login" />
      </button>
    );
  }

  const name = auth?.profile.displayName || auth?.profile.username || '';
  const revoked = status === 'device_revoked';
  const disconnected = status === 'disconnected' || revoked;
  const items: MenuItem[] = [
    { label: name, disabled: true, onSelect: () => undefined },
    ...(auth?.profile.email
      ? [{ label: auth.profile.email, disabled: true, onSelect: () => undefined }]
      : []),
    ...(revoked
      ? [
          {
            label: t('deviceRevoked.reregister'),
            separator: true,
            onSelect: () => void reregisterDevice(setAuth),
          },
        ]
      : disconnected
        ? [{ label: t('account.reconnect'), separator: true, onSelect: () => void login() }]
        : []),
    {
      label: t('account.manage'),
      separator: !disconnected,
      onSelect: () => useAppStore.getState().openSettings('cloud'),
    },
    {
      label: t('cloud.logout'),
      onSelect: () => void api.auth.logout().then(setAuth),
    },
  ];
  const label = revoked
    ? t('cloud.deviceRevoked', { name })
    : disconnected
      ? t('cloud.disconnected', { name })
      : name;
  return (
    <>
      <button
        ref={button}
        className={`icon account avatar${disconnected ? ' disconnected' : ''}`}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const r = button.current?.getBoundingClientRect();
          if (r) setMenu({ x: r.right + 4, y: r.top });
        }}
      >
        {initials(name)}
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}
