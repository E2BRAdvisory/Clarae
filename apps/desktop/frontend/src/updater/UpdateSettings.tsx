import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updaterApi, type UpdateSettings as Settings } from './api';
import { useUpdater } from './store';

/** Update preferences, shown in Settings > About. Privacy: only the manifest is fetched. */
export function UpdateSettings() {
  const { t } = useTranslation();
  const [s, setS] = useState<Settings | null>(null);
  const disabled = useUpdater((u) => u.status?.disabled ?? '');
  useEffect(() => {
    void updaterApi.getSettings().then(setS);
  }, []);
  if (!s) return null;
  const save = (next: Settings) => {
    setS(next);
    void updaterApi.setSettings(next);
  };
  return (
    <>
      <div className="row">
        <label htmlFor="upd-auto">{t('updater.auto')}</label>
        <input
          id="upd-auto"
          type="checkbox"
          checked={s.enabled}
          disabled={!!disabled}
          onChange={(e) => save({ ...s, enabled: e.target.checked })}
        />
      </div>
      <div className="row">
        <label htmlFor="upd-channel">{t('updater.channel')}</label>
        <select
          id="upd-channel"
          value={s.channel}
          disabled={!!disabled}
          onChange={(e) => save({ ...s, channel: e.target.value })}
        >
          <option value="stable">{t('updater.stable')}</option>
          <option value="beta">{t('updater.beta')}</option>
        </select>
      </div>
      <p className="muted small">
        {disabled ? t('updater.disabled', { reason: disabled }) : t('updater.privacy')}
      </p>
      <button onClick={() => void useUpdater.getState().check()}>{t('updater.checkNow')}</button>
    </>
  );
}
