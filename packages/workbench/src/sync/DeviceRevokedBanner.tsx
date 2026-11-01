import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AuthState } from '../app/api';
import { useAppStore } from '../state/store';

/**
 * Registers this device again after the cloud refused it as revoked. The new state comes back
 * (ready, or signed_out when the account itself has to sign in again); on another failure the
 * state stays device_revoked and carries the reason, which is returned as well.
 */
export async function reregisterDevice(setAuth: (a: AuthState) => void): Promise<string | null> {
  try {
    setAuth(await api.auth.reregisterDevice());
    return null;
  } catch (e) {
    setAuth(await api.auth.status());
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Shown while the cloud refuses this device as revoked (from the console or another device):
 * nothing syncs, local files and pending changes are kept, and one action registers the device
 * again, after which the pending changes are sent.
 */
export function DeviceRevokedBanner() {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (auth?.status !== 'device_revoked') return null;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setError(await reregisterDevice(setAuth));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="banner" role="alert" data-testid="device-revoked">
      <span>{t('deviceRevoked.text')}</span>
      <button className="primary" disabled={busy} onClick={() => void run()}>
        {busy ? t('deviceRevoked.busy') : t('deviceRevoked.reregister')}
      </button>
      {error && <span className="muted">{t('deviceRevoked.failed', { error })}</span>}
    </div>
  );
}
