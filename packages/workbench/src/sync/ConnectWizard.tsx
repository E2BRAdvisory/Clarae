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

/**
 * A wizard opened for one kind of vault already chosen elsewhere: the web console's "New vault"
 * opens the browser workbench on a fresh folder to create a private vault (its keys are made by the
 * core), and hands the name and the kind over.
 */
export interface WizardPreset {
  kind: 'shared' | 'private';
  name: string;
  /** The vault is linked (for a private one, after the recovery key was confirmed). */
  onLinked: (cloudVaultId: string) => void;
  onCancel: () => void;
}

/** "Connect to the cloud": kind (with explicit consequences), passphrase, recovery key, first upload. */
export function ConnectWizard({
  vaultId,
  vaultName,
  preset,
}: {
  vaultId: string;
  vaultName: string;
  preset?: WizardPreset | undefined;
}) {
  const { t } = useTranslation();
  const auth = useAppStore((s) => s.auth);
  const status = useSync((s) => s.status[vaultId]);
  const [choice, setChoice] = useState<Choice>(preset?.kind ?? 'shared');
  const [name, setName] = useState(preset?.name ?? vaultName);
  const [step, setStep] = useState<Step>(preset?.kind === 'private' ? 'passphrase' : 'choose');
  const [cloudVaultId, setCloudVaultId] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [warning, setWarning] = useState('');
  const [existing, setExisting] = useState<CloudVault[]>([]);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const signedIn = auth?.status === 'ready' || auth?.status === 'disconnected';
  const close = () => (preset ? preset.onCancel() : useSync.getState().setWizardOpen(false));

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
      setCloudVaultId(res.cloudVaultId);
      setWarning(res.warning ?? '');
      if (choice === 'private') {
        setRecoveryKey(res.recoveryKey);
        setStep('recovery');
      } else if (preset) {
        preset.onLinked(res.cloudVaultId);
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
            {preset && (
              <p>
                <strong>{name}</strong> · {t('sync.kindPrivate')}
              </p>
            )}
            <p>{t('sync.passphraseIntro')}</p>
            {preset && <p className="warning small">{t('sync.irreversible')}</p>}
            <PassphraseFields idPrefix="wizard" onValid={onValid} />
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div className="actions">
              {preset ? (
                <button onClick={close}>{t('dialog.cancel')}</button>
              ) : (
                <button onClick={() => setStep('choose')}>{t('sync.back')}</button>
              )}
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
          <>
            <LinkWarning code={warning} />
            <RecoveryKeyStep
              recoveryKey={recoveryKey}
              onConfirmed={() => (preset ? preset.onLinked(cloudVaultId) : setStep('progress'))}
            />
          </>
        ) : (
          <>
            <LinkWarning code={warning} />
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

/** What SyncAPI.LinkNew reports when the vault was created but something is left to do. */
const LINK_WARNINGS: Record<string, string> = {
  'keychain-unavailable': 'sync.linkWarningKeychain',
  'link-incomplete': 'sync.linkWarningIncomplete',
};

function LinkWarning({ code }: { code: string }) {
  const { t } = useTranslation();
  if (!code) return null;
  return (
    <div className="warning small" role="alert">
      {t(LINK_WARNINGS[code] ?? 'sync.linkWarningOther', { code })}
    </div>
  );
}
