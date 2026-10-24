import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { checkPassphrase, type PassphraseCheck } from './strength';

interface Props {
  idPrefix: string;
  /** Called with the passphrase when it is acceptable and confirmed, "" otherwise. */
  onValid: (passphrase: string) => void;
}

/** New-passphrase entry: confirmation field and a strength meter (min. 12 characters, zxcvbn >= 3). */
export function PassphraseFields({ idPrefix, onValid }: Props) {
  const { t } = useTranslation();
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [check, setCheck] = useState<PassphraseCheck>({ score: 0, longEnough: false, ok: false });

  useEffect(() => {
    let stale = false;
    void checkPassphrase(pass).then((c) => !stale && setCheck(c));
    return () => {
      stale = true;
    };
  }, [pass]);

  useEffect(() => {
    onValid(check.ok && pass === again ? pass : '');
  }, [check, pass, again, onValid]);

  const mismatch = again !== '' && pass !== again;
  return (
    <div className="passphrase">
      <label htmlFor={`${idPrefix}-pass`}>{t('sync.passphrase')}</label>
      <input
        id={`${idPrefix}-pass`}
        type="password"
        autoComplete="new-password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      <div
        className={`meter score-${check.score}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={check.score}
        aria-label={t('sync.strength')}
      >
        <span style={{ width: `${(check.score + 1) * 20}%` }} />
      </div>
      <div className="muted small" role="status">
        {pass === ''
          ? t('sync.passphraseHint')
          : !check.longEnough
            ? t('sync.tooShort', { n: 12 })
            : check.ok
              ? t('sync.strengthOk')
              : t('sync.strengthLow')}
      </div>
      <label htmlFor={`${idPrefix}-again`}>{t('sync.passphraseAgain')}</label>
      <input
        id={`${idPrefix}-again`}
        type="password"
        autoComplete="new-password"
        value={again}
        onChange={(e) => setAgain(e.target.value)}
      />
      {mismatch && (
        <div className="error small" role="alert">
          {t('sync.passphraseMismatch')}
        </div>
      )}
    </div>
  );
}
