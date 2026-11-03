import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useAppStore } from '../state/store';
import { ActionButton, useAction } from '../ui/ActionButton';
import { AccountDevices } from './AccountDevices';
import { CloudVaults } from './CloudVaults';

export function CloudSection() {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.auth);
  const [server, setServer] = useState('');
  // On the web the session is the page's (the console signs in and out): no account:sign-in, so
  // no login form here.
  const signsIn = useAction('account:sign-in', server) !== null;
  const [busy, setBusy] = useState(false);

  // Development convenience: MEMOBRAIN_DEFAULT_SERVER_URL prefills the address.
  useEffect(() => {
    void api.settings.info().then((i) => {
      if (i.defaultServer) setServer((cur) => cur || (i.defaultServer ?? ''));
    });
  }, []);

  const status = auth?.status ?? 'signed_out';
  const name = auth?.profile.displayName || auth?.profile.username || '';

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
        {signedIn && <ActionButton id="account:sign-out" />}
      </div>
      {signedIn ? (
        <div className="muted">
          {auth?.serverUrl} · {t('cloud.role')}: {auth?.profile.role}
        </div>
      ) : (
        signsIn && (
          <div className="row">
            <input
              aria-label={t('cloud.serverUrl')}
              placeholder={t('cloud.placeholder')}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              style={{ flex: 1 }}
            />
            <ActionButton
              id="account:sign-in"
              arg={server}
              className="primary"
              disabled={busy}
              onPending={setBusy}
            />
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
