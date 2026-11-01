import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useAppStore } from '../state/store';
import { AccountDevices } from './AccountDevices';
import { CloudVaults } from './CloudVaults';

export function CloudSection() {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
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

  const signedIn = status === 'ready' || status === 'disconnected';
  return (
    <div className="cloud">
      <div className="row">
        <span>
          {status === 'signing_in' || busy
            ? t('cloud.signingIn')
            : signedIn
              ? t(status === 'ready' ? 'cloud.ready' : 'cloud.disconnected', { name })
              : t('cloud.signedOut')}
        </span>
        {signedIn && <button onClick={() => void logout()}>{t('cloud.logout')}</button>}
      </div>
      {signedIn ? (
        <div className="muted">
          {auth?.serverUrl} · {t('cloud.role')}: {auth?.profile.role}
        </div>
      ) : (
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
      )}
      {signedIn && <CloudVaults />}
      {signedIn && <AccountDevices />}
      {auth?.error && (
        <div className="muted" role="alert" style={{ color: 'var(--danger)' }}>
          {auth.error}
        </div>
      )}
    </div>
  );
}
