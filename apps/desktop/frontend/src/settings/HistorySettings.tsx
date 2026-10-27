import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type HistorySettings as Values } from '../app/api';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';

const FIELDS: { key: keyof Values; label: string; min: number }[] = [
  { key: 'intervalMinutes', label: 'recovery.settingsInterval', min: 1 },
  { key: 'retentionDays', label: 'recovery.settingsRetention', min: 1 },
  { key: 'maxFileMb', label: 'recovery.settingsMaxFile', min: 1 },
  { key: 'maxTotalMb', label: 'recovery.settingsMaxTotal', min: 10 },
];

/** File recovery settings of the open vault (stored in .memobrain/history.json). */
export function HistorySettings() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const vaultId = vault?.id;
  const [values, setValues] = useState<Values | null>(null);

  useEffect(() => {
    if (!vaultId) return;
    let live = true;
    api.history.getSettings(vaultId).then(
      (s) => live && setValues(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [vaultId]);

  if (!vaultId || !values) return null;

  const commit = async (next: Values) => {
    setValues(next);
    try {
      setValues(await api.history.setSettings(vaultId, next));
    } catch (e) {
      await dialog.error(e);
    }
  };

  return (
    <>
      <h4>{t('recovery.settingsTitle')}</h4>
      {FIELDS.map((f) => (
        <div className="row" key={f.key}>
          <label htmlFor={`history-${f.key}`}>{t(f.label)}</label>
          <fieldset className="row-controls">
            <input
              id={`history-${f.key}`}
              type="number"
              min={f.min}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: Number(e.target.value) })}
              onBlur={() => void commit(values)}
            />
          </fieldset>
        </div>
      ))}
    </>
  );
}
