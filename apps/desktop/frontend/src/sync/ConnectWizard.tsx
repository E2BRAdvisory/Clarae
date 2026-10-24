import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type CloudVault } from '../app/api';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { PassphraseFields } from './PassphraseFields';
import { RecoveryKeyStep } from './RecoveryKeyStep';

type Choice = 'shared' | 'private' | 'existing';
type Step = 'choose' | 'passphrase' | 'recovery' | 'progress';

/** "Connect to the cloud": kind (with explicit consequences), passphrase, recovery key, first upload. */
export function ConnectWizard({ vaultId, vaultName }: { vaultId: string; vaultName: string }) {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.auth);
  const status = useSync((s) => s.status[vaultId]);
  const [choice, setChoice] = useState<Choice>('shared');
  const [name, setName] = useState(vaultName);
  const [step, setStep] = useState<Step>('choose');
  const [passphrase, setPassphrase] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [existing, setExisting] = useState<CloudVault[]>([]);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const signedIn = auth?.status === 'ready' || auth?.status === 'disconnected';
  const close = () => useSync.getState().setWizardOpen(false);

  useEffect(() => {
    if (signedIn && choice === 'existing') {
      void api.sync
        .listCloudVaults()
        .then((vs) => {
          setExisting(vs);
          setPicked((p) => p || vs[0]?.id || '');
        })
        .catch((e) => setError(String(e)));
    }
  }, [signedIn, choice]);

  const onValid = useCallback((p: string) => setPassphrase(p), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const link = () =>
    run(async () => {
      if (choice === 'existing') {
        await api.sync.linkExisting(vaultId, picked);
        await useSync.getState().refresh(vaultId);
        const info = await api.sync.info(vaultId);
        close();
        if (info.kind === 'private') useSync.getState().setUnlockOpen(true);
        return;
      }
      const res = await api.sync.linkNew(
        vaultId,
        name.trim(),
        choice,
        choice === 'private' ? passphrase : '',
      );
      await useSync.getState().refresh(vaultId);
      if (choice === 'private') {
        setRecoveryKey(res.recoveryKey);
        setStep('recovery');
      } else {
        setStep('progress');
      }
    });

  const next = () => {
    if (step === 'choose' && choice === 'private') setStep('passphrase');
    else void link();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal wizard"
        role="dialog"
        aria-modal="true"
        aria-label={t('sync.connectTitle')}
      >
        <h2>{t('sync.connectTitle')}</h2>

        {!signedIn ? (
          <>
            <p>{t('sync.needSignIn')}</p>
            <div className="actions">
              <button onClick={close}>{t('dialog.cancel')}</button>
              <button
                className="primary"
                onClick={() => {
                  close();
                  useAppStore.getState().openSettings('cloud');
                }}
              >
                {t('sync.openCloudSettings')}
              </button>
            </div>
          </>
        ) : step === 'choose' ? (
          <>
            <fieldset className="choices">
              <label className={choice === 'shared' ? 'choice active' : 'choice'}>
                <input
                  type="radio"
                  name="kind"
                  checked={choice === 'shared'}
                  onChange={() => setChoice('shared')}
                />
                <span>
                  <strong>{t('sync.kindShared')}</strong>
                  <span className="muted small">{t('sync.kindSharedText')}</span>
                </span>
              </label>
              <label className={choice === 'private' ? 'choice active' : 'choice'}>
                <input
                  type="radio"
                  name="kind"
                  checked={choice === 'private'}
                  onChange={() => setChoice('private')}
                />
                <span>
                  <strong>{t('sync.kindPrivate')}</strong>
                  <span className="muted small">{t('sync.kindPrivateText')}</span>
                </span>
              </label>
              <label className={choice === 'existing' ? 'choice active' : 'choice'}>
                <input
                  type="radio"
                  name="kind"
                  checked={choice === 'existing'}
                  onChange={() => setChoice('existing')}
                />
                <span>
                  <strong>{t('sync.kindExisting')}</strong>
                  <span className="muted small">{t('sync.kindExistingText')}</span>
                </span>
              </label>
            </fieldset>
            {choice === 'existing' ? (
              existing.length === 0 ? (
                <p className="muted">{t('sync.noCloudVaults')}</p>
              ) : (
                <select
                  aria-label={t('sync.pickVault')}
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {existing.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({t(`sync.kind_${v.kind}`)})
                    </option>
                  ))}
                </select>
              )
            ) : (
              <>
                <label htmlFor="cloud-name">{t('sync.cloudName')}</label>
                <input id="cloud-name" value={name} onChange={(e) => setName(e.target.value)} />
              </>
            )}
            {choice === 'private' && <p className="warning small">{t('sync.irreversible')}</p>}
            {choice !== 'existing' && <p className="muted small">{t('sync.kindFixed')}</p>}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="actions">
              <button onClick={close}>{t('dialog.cancel')}</button>
              <button
                className="primary"
                disabled={busy || (choice === 'existing' ? !picked : name.trim() === '')}
                onClick={next}
              >
                {choice === 'private' ? t('sync.next') : t('sync.connect')}
              </button>
            </div>
          </>
        ) : step === 'passphrase' ? (
          <>
            <p>{t('sync.passphraseIntro')}</p>
            <PassphraseFields idPrefix="wizard" onValid={onValid} />
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="actions">
              <button onClick={() => setStep('choose')}>{t('sync.back')}</button>
              <button
                className="primary"
                disabled={busy || passphrase === ''}
                onClick={() => void link()}
              >
                {t('sync.createEncrypted')}
              </button>
            </div>
          </>
        ) : step === 'recovery' ? (
          <RecoveryKeyStep recoveryKey={recoveryKey} onConfirmed={() => setStep('progress')} />
        ) : (
          <>
            <p>{status?.phase === 'syncing' ? t('sync.uploading') : t('sync.connected')}</p>
            <progress
              max={Math.max(status?.total ?? 0, 1)}
              value={status?.phase === 'syncing' ? status.done : 1}
              aria-label={t('sync.progress')}
            />
            {status && status.phase === 'syncing' && status.total > 0 && (
              <div className="muted small">
                {t('sync.progressOf', { done: status.done, total: status.total })}
              </div>
            )}
            {status?.phase === 'error' && (
              <div className="error" role="alert">
                {status.error}
              </div>
            )}
            <div className="actions">
              <button className="primary" onClick={close}>
                {status?.phase === 'syncing' ? t('sync.continueBackground') : t('sync.done')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export async function confirmDisconnect(t: (k: string) => string): Promise<boolean> {
  return dialog.confirm(t('sync.disconnect'), t('sync.disconnectText'), true);
}
