import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useCan } from '../platform';
import { useAppStore } from '../state/store';
import { AccountDevices } from './AccountDevices';
import { CloudVaults } from './CloudVaults';

export function CloudSection() {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  // On the web the session is the page's (the console signs in and out): no login form here.
  const ownsSession = useCan('ownsSession');
  const [server, setServer] = useState('');
  const [busy, setBusy] = useState(false);

  // Development convenience: MEMOBRAIN_DEFAULT_SERVER_URL prefills the address.
  useEffect(() => {
    void api.settings.info().then((i) => {
      if (i.defaultServer) setServer((cur) => cur || (i.defaultServer ?? ''));
    });
  }, []);

  const status = auth?.status ?? 'signed_out';
  const name = auth?.profile.displayName || auth?.profile.username || '';

  const login = async () => {
    setBusy(true);
    try {
      setAuth(await api.auth.login(server || auth?.serverUrl || ''));
    } catch {
      setAuth(await api.auth.status()); // the error text is part of the state
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => setAuth(await api.auth.logout());

  const signedIn = status === 'ready' || status === 'disconnected' || status === 'device_revoked';
  return (
    <div className="cloud">
      <div className="row">
        <span>
          {status === 'signing_in' || busy
            ? t('cloud.signingIn')
            : signedIn
              ? t(
                  status === 'ready'
                    ? 'cloud.ready'
                    : status === 'device_revoked'
                      ? 'cloud.deviceRevoked'
                      : 'cloud.disconnected',
                  { name },
                )
              : t('cloud.signedOut')}
        </span>
        {signedIn && ownsSession && (
          <button onClick={() => void logout()}>{t('cloud.logout')}</button>
        )}
      </div>
      {signedIn ? (
        <div className="muted">
          {auth?.serverUrl} · {t('cloud.role')}: {auth?.profile.role}
        </div>
      ) : (
        ownsSession && (
          <div className="row">
            <input
              aria-label={t('cloud.serverUrl')}
              placeholder={t('cloud.placeholder')}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="primary" disabled={busy || !server} onClick={() => void login()}>
              {t('cloud.login')}
            </button>
          </div>
        )
      )}
      {/* While the device is revoked the cloud lists nothing for it: the banner offers the way back. */}
      {signedIn && status !== 'device_revoked' && <CloudVaults />}
      {signedIn && status !== 'device_revoked' && <AccountDevices />}
      {auth?.error && (
        <div className="muted" role="alert" style={{ color: 'var(--danger)' }}>
          {auth.error}
        </div>
      )}
    </div>
  );
}
