import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AppSettings } from '../app/api';
import { applyTheme, type Theme } from '../app/theme';
import { initI18n } from '../i18n';
import {
  applyAppearance,
  useSettings,
  type EditorSettings,
  type LinkFormat,
  type NoteMode,
} from '../state/settings';
import { useAppStore, type SettingsSection } from '../state/store';
import { CloudSection } from './CloudSection';
import { useImporter } from '../importer/store';
import { SharingPanel } from '../sharing/SharingPanel';
import { editorKeyOf, isLocked, useManaged } from '../state/managed';
import { SyncSection } from './SyncSection';
import { DailySection } from './DailySection';
import { HotkeysEditor } from './HotkeysEditor';
import { HistorySettings } from './HistorySettings';
import { FilesExtra } from './FilesExtra';

const SECTIONS: SettingsSection[] = [
  'general',
  'editor',
  'files',
  'daily',
  'appearance',
  'hotkeys',
  'cloud',
  'sync',
  'sharing',
  'about',
];

/**
 * One setting. With `cfg` (its dotted key in the distributed configuration) the row is disabled
 * and marked when an administrator locked that key (§2.6.6).
 */
function Row({
  label,
  htmlFor,
  children,
  cfg,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  cfg?: string | undefined;
}) {
  const { t } = useTranslation();
  const locked = useManaged((m) => (cfg ? isLocked(m.locked, cfg) : false));
  return (
    <div className={`row${locked ? ' managed' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      <fieldset className="row-controls" disabled={locked}>
        {children}
      </fieldset>
      {locked && (
        <span className="muted small managed-note">🔒 {t('settings.managedByAdmin')}</span>
      )}
    </div>
  );
}

/** The dotted configuration key of an editor setting. */
function editorCfg(field: keyof EditorSettings): string | undefined {
  const key = editorKeyOf(field);
  return key ? `editor.${key}` : undefined;
}

function Toggle({
  id,
  label,
  k,
}: {
  id: string;
  label: string;
  k: keyof EditorSettings &
    (
      | 'lineNumbers'
      | 'wrap'
      | 'readableWidth'
      | 'spellcheck'
      | 'autoPair'
      | 'smartPaste'
      | 'foldHeadings'
      | 'pagePreview'
      | 'pagePreviewAlways'
    );
}) {
  const value = useSettings((s) => s.editor[k]);
  const setEditor = useSettings((s) => s.setEditor);
  return (
    <Row label={label} htmlFor={id} cfg={editorCfg(k)}>
      <input
        id={id}
        type="checkbox"
        checked={value}
        onChange={(e) => setEditor({ [k]: e.target.checked })}
      />
    </Row>
  );
}

export function SettingsPanel() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const section = useAppStore((s) => s.settingsSection);
  const close = () => useAppStore.getState().closeSettings();
  const editor = useSettings((s) => s.editor);
  const appearance = useSettings((s) => s.appearance);
  const setEditor = useSettings((s) => s.setEditor);
  const setAppearance = useSettings((s) => s.setAppearance);
  const vault = useAppStore((s) => s.vault);
  const [info, setInfo] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.settings.info().then(setInfo);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const update = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    applyTheme(next.theme as Theme);
    initI18n(next.language || undefined);
    await api.settings.set(next);
  };

  const body = (): ReactNode => {
    switch (section) {
      case 'general':
        return (
          <>
            <Row label={t('settings.language')} htmlFor="language">
              <select
                id="language"
                value={settings.language}
                onChange={(e) => void update({ language: e.target.value })}
              >
                <option value="">{t('settings.languageSystem')}</option>
                <option value="en">English</option>
                <option value="it">Italiano</option>
              </select>
            </Row>
            <Row label={t('settings.theme')} cfg="appearance.theme" htmlFor="theme">
              <select
                id="theme"
                value={settings.theme}
                onChange={(e) => void update({ theme: e.target.value })}
              >
                <option value="system">{t('settings.themeSystem')}</option>
                <option value="light">{t('settings.themeLight')}</option>
                <option value="dark">{t('settings.themeDark')}</option>
              </select>
            </Row>
          </>
        );
      case 'editor':
        return (
          <>
            {!vault && <p className="muted">{t('settings.needsVault')}</p>}
            <Row label={t('settings.defaultMode')} htmlFor="defaultMode">
              <select
                id="defaultMode"
                value={editor.defaultMode}
                onChange={(e) => setEditor({ defaultMode: e.target.value as NoteMode })}
              >
                <option value="live">{t('editor.mode_live')}</option>
                <option value="source">{t('editor.mode_source')}</option>
                <option value="reading">{t('editor.mode_reading')}</option>
              </select>
            </Row>
            <Toggle id="lineNumbers" label={t('settings.lineNumbers')} k="lineNumbers" />
            <Toggle id="wrap" label={t('settings.wrap')} k="wrap" />
            <Toggle id="readableWidth" label={t('settings.readableWidth')} k="readableWidth" />
            <Toggle id="spellcheck" label={t('settings.spellcheck')} k="spellcheck" />
            <Toggle id="autoPair" label={t('settings.autoPair')} k="autoPair" />
            <Toggle id="smartPaste" label={t('settings.smartPaste')} k="smartPaste" />
            <Toggle id="foldHeadings" label={t('settings.foldHeadings')} k="foldHeadings" />
            <Toggle id="pagePreview" label={t('settings.pagePreview')} k="pagePreview" />
            <Toggle
              id="pagePreviewAlways"
              label={t('settings.pagePreviewAlways')}
              k="pagePreviewAlways"
            />
            <Row label={t('settings.fontSize')} cfg="editor.fontSize" htmlFor="fontSize">
              <input
                id="fontSize"
                type="number"
                min={10}
                max={32}
                value={editor.fontSize}
                onChange={(e) =>
                  setEditor({ fontSize: Math.min(32, Math.max(10, Number(e.target.value) || 15)) })
                }
              />
            </Row>
            <Row label={t('settings.tabSize')} htmlFor="tabSize">
              <input
                id="tabSize"
                type="number"
                min={1}
                max={8}
                value={editor.tabSize}
                onChange={(e) =>
                  setEditor({ tabSize: Math.min(8, Math.max(1, Number(e.target.value) || 4)) })
                }
              />
            </Row>
          </>
        );
      case 'files':
        return (
          <>
            {!vault && <p className="muted">{t('settings.needsVault')}</p>}
            <Row label={t('settings.linkFormat')} cfg="editor.linkFormat" htmlFor="linkFormat">
              <select
                id="linkFormat"
                value={editor.linkFormat}
                onChange={(e) => setEditor({ linkFormat: e.target.value as LinkFormat })}
              >
                <option value="shortest">{t('settings.linkShortest')}</option>
                <option value="path">{t('settings.linkPath')}</option>
                <option value="relative">{t('settings.linkRelative')}</option>
              </select>
            </Row>
            <Row
              label={t('settings.newNoteFolder')}
              cfg="editor.newNoteFolder"
              htmlFor="newNoteFolder"
            >
              <input
                id="newNoteFolder"
                value={editor.newNoteFolder}
                placeholder="/"
                onChange={(e) => setEditor({ newNoteFolder: e.target.value })}
              />
            </Row>
            <Row
              label={t('settings.attachmentsFolder')}
              cfg="editor.attachmentsFolder"
              htmlFor="attachmentsFolder"
            >
              <input
                id="attachmentsFolder"
                value={editor.attachmentsFolder}
                placeholder="attachments"
                onChange={(e) => setEditor({ attachmentsFolder: e.target.value })}
              />
            </Row>
            <Row label={t('settings.trashMode')} htmlFor="trashMode">
              <select
                id="trashMode"
                value={settings.trashMode || 'system'}
                onChange={(e) => void update({ trashMode: e.target.value })}
              >
                <option value="system">{t('settings.trashSystem')}</option>
                <option value="vault">{t('settings.trashVault')}</option>
              </select>
            </Row>
            <HistorySettings />
            <FilesExtra />
            <Row label={t('settings.importNotes')} htmlFor="importNotes">
              <button
                id="importNotes"
                disabled={!vault}
                onClick={() => {
                  useAppStore.getState().closeSettings();
                  useImporter.getState().show();
                }}
              >
                {t('commands.import_open')}
              </button>
            </Row>
          </>
        );
      case 'appearance':
        return (
          <>
            {!vault && <p className="muted">{t('settings.needsVault')}</p>}
            <Row label={t('settings.accent')} cfg="appearance.accent" htmlFor="accent">
              <input
                id="accent"
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(appearance.accent) ? appearance.accent : '#6c5ce7'}
                onChange={(e) => {
                  setAppearance({ accent: e.target.value });
                  applyAppearance({ ...appearance, accent: e.target.value });
                }}
              />
            </Row>
            <Row label={t('settings.interfaceFont')} htmlFor="fontFamily">
              <input
                id="fontFamily"
                value={appearance.fontFamily}
                placeholder="system-ui"
                onChange={(e) => {
                  setAppearance({ fontFamily: e.target.value });
                  applyAppearance({ ...appearance, fontFamily: e.target.value });
                }}
              />
            </Row>
            <Row label={t('settings.interfaceFontSize')} htmlFor="ifs">
              <input
                id="ifs"
                type="number"
                min={10}
                max={24}
                value={appearance.interfaceFontSize}
                onChange={(e) => {
                  const v = Math.min(24, Math.max(10, Number(e.target.value) || 14));
                  setAppearance({ interfaceFontSize: v });
                  applyAppearance({ ...appearance, interfaceFontSize: v });
                }}
              />
            </Row>
            <Row label={t('settings.zoom')} cfg="appearance.zoom" htmlFor="zoom">
              <input
                id="zoom"
                type="range"
                min={50}
                max={200}
                step={10}
                value={appearance.zoom}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setAppearance({ zoom: v });
                  applyAppearance({ ...appearance, zoom: v });
                }}
              />
              <span className="muted">{appearance.zoom}%</span>
            </Row>
          </>
        );
      case 'hotkeys':
        return <HotkeysEditor />;
      case 'cloud':
        return <CloudSection />;
      case 'sync':
        return <SyncSection />;
      case 'daily':
        return <DailySection />;
      case 'sharing':
        return <SharingPanel />;
      case 'about':
        return (
          <>
            <Row label={t('settings.version')}>
              <span className="muted">{info['version'] ?? '—'}</span>
            </Row>
            <Row label={t('settings.dataDir')}>
              <span className="muted" style={{ userSelect: 'text' }}>
                {info['dataDir'] ?? '—'}
              </span>
            </Row>
          </>
        );
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} role="presentation">
      <div
        className="modal settings"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <nav className="settings-nav" aria-label={t('settings.title')}>
          <h2>{t('settings.title')}</h2>
          {SECTIONS.map((s) => (
            <button
              key={s}
              className={section === s ? 'active' : ''}
              onClick={() => useAppStore.setState({ settingsSection: s })}
            >
              {t(`settings.section_${s}`)}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <h3>{t(`settings.section_${section}`)}</h3>
          {body()}
          <div className="actions">
            <button onClick={close}>{t('settings.close')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
