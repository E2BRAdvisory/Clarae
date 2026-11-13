import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sameRecoveryKey } from './strength';

interface Props {
  recoveryKey: string;
  /** The user retyped the key correctly. */
  onConfirmed: () => void;
  confirmLabel?: string;
}

/** Shows the recovery key once and makes the user retype it before continuing. */
export function RecoveryKeyStep({ recoveryKey, onConfirmed, confirmLabel }: Props) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);
  const ok = sameRecoveryKey(typed, recoveryKey);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      /* clipboard unavailable: the key is visible anyway */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([`Clarae notanda recovery key\n\n${recoveryKey}\n`], { type: 'text/plain' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'clarae-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="recovery">
      <p>{t('sync.recoveryIntro')}</p>
      <div className="recovery-key" aria-label={t('sync.recoveryKey')}>
        {recoveryKey}
      </div>
      <div className="row">
        <button onClick={() => void copy()}>{copied ? t('sync.copied') : t('sync.copy')}</button>
        <button onClick={download}>{t('sync.download')}</button>
      </div>
      <p className="warning small">{t('sync.recoveryWarning')}</p>
      <label htmlFor="recovery-confirm">{t('sync.recoveryRetype')}</label>
      <input
        id="recovery-confirm"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="actions">
        <button className="primary" disabled={!ok} onClick={onConfirmed}>
          {confirmLabel ?? t('sync.recoverySaved')}
        </button>
      </div>
    </div>
  );
}
