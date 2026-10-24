import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AppSettings } from '../app/api';
import { applyTheme, type Theme } from '../app/theme';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { CloudSection } from './CloudSection';

export function SettingsPanel() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const close = () => useAppStore.getState().setSettingsOpen(false);
  const [info, setInfo] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.settings.info().then(setInfo);
  }, []);

  const update = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    applyTheme(next.theme as Theme);
    initI18n(next.language || undefined);
    await api.settings.set(next);
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>{t('settings.title')}</h2>

        <h3>{t('settings.general')}</h3>
        <div className="row">
          <label htmlFor="language">{t('settings.language')}</label>
          <select
            id="language"
            value={settings.language}
            onChange={(e) => void update({ language: e.target.value })}
          >
            <option value="">{t('settings.languageSystem')}</option>
            <option value="en">English</option>
            <option value="it">Italiano</option>
          </select>
        </div>
        <div className="row">
          <label htmlFor="theme">{t('settings.theme')}</label>
          <select
            id="theme"
            value={settings.theme}
            onChange={(e) => void update({ theme: e.target.value })}
          >
            <option value="system">{t('settings.themeSystem')}</option>
            <option value="light">{t('settings.themeLight')}</option>
            <option value="dark">{t('settings.themeDark')}</option>
          </select>
        </div>

        <h3>{t('settings.cloud')}</h3>
        <CloudSection />

        <h3>{t('settings.about')}</h3>
        <div className="row">
          <span>{t('settings.version')}</span>
          <span className="muted">{info.version ?? '—'}</span>
        </div>
        <div className="row">
          <span>{t('settings.dataDir')}</span>
          <span className="muted" style={{ userSelect: 'text' }}>
            {info.dataDir ?? '—'}
          </span>
        </div>

        <div className="actions">
          <button onClick={close}>{t('settings.close')}</button>
        </div>
      </div>
    </div>
  );
}
