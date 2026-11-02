import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useSync } from '../state/sync';
import { errorMessage } from '../util/errors';
import { PassphraseFields } from './PassphraseFields';
import { RecoveryKeyStep } from './RecoveryKeyStep';

type Step = 'secret' | 'newpass' | 'newkey' | 'newkeyshow';

/** Unlock a private vault; unlocking with the recovery key forces a new passphrase (§3.8.4). */
export function UnlockDialog({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const [recovery, setRecovery] = useState(false);
  const [secret, setSecret] = useState('');
  const [step, setStep] = useState<Step>('secret');
  const [newPass, setNewPass] = useState('');
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    useSync.getState().setUnlockOpen(false);
    void useSync.getState().refresh(vaultId);
  };
  const onValid = useCallback((p: string) => setNewPass(p), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const unlock = () =>
    run(async () => {
      const mustChange = await api.crypto.unlock(vaultId, secret, recovery);
      if (mustChange) setStep('newpass');
      else close();
    });

  const savePass = () =>
    run(async () => {
      await api.crypto.setPassphrase(vaultId, newPass);
      setStep('newkey');
    });

  const regenerate = () =>
    run(async () => {
      setNewKey(await api.crypto.regenerateRecoveryKey(vaultId, newPass));
      setStep('newkeyshow');
    });

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal wizard"
        role="dialog"
        aria-modal="true"
        aria-label={t('sync.unlockTitle')}
      >
        <h2>{t('sync.unlockTitle')}</h2>
        {step === 'secret' && (
          <>
            <p>{t('sync.unlockIntro')}</p>
            <div className="row">
              <label>
                <input
                  type="radio"
                  name="how"
                  checked={!recovery}
                  onChange={() => setRecovery(false)}
                />{' '}
                {t('sync.usePassphrase')}
              </label>
              <label>
                <input
                  type="radio"
                  name="how"
                  checked={recovery}
                  onChange={() => setRecovery(true)}
                />{' '}
                {t('sync.useRecoveryKey')}
              </label>
            </div>
            <label htmlFor="unlock-secret">
              {recovery ? t('sync.recoveryKey') : t('sync.passphrase')}
            </label>
            <input
              id="unlock-secret"
              type={recovery ? 'text' : 'password'}
              value={secret}
              autoFocus
              autoComplete="off"
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && secret && void unlock()}
            />
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="actions">
              <button onClick={close}>{t('sync.later')}</button>
              <button
                className="primary"
                disabled={busy || secret === ''}
                onClick={() => void unlock()}
              >
                {t('sync.unlock')}
              </button>
            </div>
          </>
        )}
        {step === 'newpass' && (
          <>
            <p>{t('sync.newPassphraseAfterRecovery')}</p>
            <PassphraseFields idPrefix="unlock" onValid={onValid} />
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="actions">
              <button
                className="primary"
                disabled={busy || newPass === ''}
                onClick={() => void savePass()}
              >
                {t('sync.savePassphrase')}
              </button>
            </div>
          </>
        )}
        {step === 'newkey' && (
          <>
            <p>{t('sync.regeneratePrompt')}</p>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="actions">
              <button onClick={close}>{t('sync.keepOldKey')}</button>
              <button className="primary" disabled={busy} onClick={() => void regenerate()}>
                {t('sync.generateNewKey')}
              </button>
            </div>
          </>
        )}
        {step === 'newkeyshow' && <RecoveryKeyStep recoveryKey={newKey} onConfirmed={close} />}
      </div>
    </div>
  );
}
