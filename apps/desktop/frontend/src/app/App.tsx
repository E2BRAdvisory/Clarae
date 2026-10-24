import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AuthState } from './api';
import { Events, type FileChangedPayload, type IndexProgressPayload } from './events';
import { applyTheme, type Theme } from './theme';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { useInvalidate, useRecentVaults } from '../state/queries';
import { FileExplorer } from '../sidebar/FileExplorer';
import { SearchPanel } from '../search/SearchPanel';
import { Editor } from '../editor/Editor';
import { SettingsPanel } from '../settings/SettingsPanel';
import { BacklinksPanel } from '../sidebar/BacklinksPanel';

export function App() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const setVault = useAppStore((s) => s.setVault);
  const setSettings = useAppStore((s) => s.setSettings);
  const setAuth = useAppStore((s) => s.setAuth);
  const setIndexProgress = useAppStore((s) => s.setIndexProgress);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const invalidate = useInvalidate();

  // Load preferences once.
  useEffect(() => {
    void api.settings.get().then((s) => {
      setSettings(s);
      applyTheme((s.theme || 'system') as Theme);
      initI18n(s.language || undefined);
    });
  }, [setSettings]);

  // Cloud session: initial state, then pushed updates.
  useEffect(() => {
    void api.auth.status().then(setAuth);
    return api.on<AuthState>(Events.authState, setAuth);
  }, [setAuth]);

  // Backend events.
  useEffect(() => {
    const offFile = api.on<FileChangedPayload>(Events.vaultFileChanged, (p) => {
      void invalidate.tree(p.vaultId);
      void invalidate.search(p.vaultId);
      void invalidate.backlinks(p.vaultId);
    });
    const offIndex = api.on<IndexProgressPayload>(Events.indexProgress, (p) => {
      setIndexProgress(p.finished ? null : p);
      if (p.finished) void invalidate.search(p.vaultId);
    });
    return () => {
      offFile();
      offIndex();
    };
  }, [invalidate, setIndexProgress]);

  const openVault = async (path: string) => {
    try {
      const info = await api.vault.open(path);
      setVault(info);
      await invalidate.recent();
    } catch (e) {
      window.alert(String(e));
    }
  };

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="title">{vault ? vault.name : t('app.name')}</span>
        <span className="spacer" />
        <button
          className="icon"
          title={t('settings.title')}
          onClick={() => useAppStore.getState().setSettingsOpen(true)}
        >
          ⚙
        </button>
      </header>
      {vault ? <VaultView vaultId={vault.id} /> : <Welcome onOpen={openVault} />}
      <StatusBar />
      {settingsOpen && <SettingsPanel />}
    </div>
  );
}

function Welcome({ onOpen }: { onOpen: (path: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { data: recent = [] } = useRecentVaults();
  const pick = async () => {
    const path = await api.vault.pickFolder(t('welcome.pickTitle'));
    if (path) await onOpen(path);
  };
  return (
    <main className="welcome">
      <div className="card">
        <h1>{t('welcome.title')}</h1>
        <p className="muted">{t('welcome.subtitle')}</p>
        <button className="primary" onClick={() => void pick()}>
          {t('welcome.openFolder')}
        </button>
        {recent.length > 0 && (
          <div className="recent">
            <h3>{t('welcome.recent')}</h3>
            {recent.map((v) => (
              <button key={v.path} onClick={() => void onOpen(v.path)}>
                {v.name}
                <span className="path">{v.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function VaultView({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const tab = useAppStore((s) => s.sidebarTab);
  const setTab = useAppStore((s) => s.setSidebarTab);
  const openPath = useAppStore((s) => s.openPath);
  const setVault = useAppStore((s) => s.setVault);

  const closeVault = async () => {
    await api.vault.close(vaultId);
    setVault(null);
  };

  return (
    <>
      <aside className="sidebar">
        <div className="tabs">
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            {t('sidebar.files')}
          </button>
          <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
            {t('sidebar.search')}
          </button>
        </div>
        {tab === 'files' ? <FileExplorer vaultId={vaultId} /> : <SearchPanel vaultId={vaultId} />}
        <div className="toolbar">
          <button
            className="icon"
            title={t('sidebar.rebuildIndex')}
            onClick={() => void api.vault.rebuildIndex(vaultId)}
          >
            ⟳
          </button>
          <button
            className="icon"
            title={t('sidebar.closeVault')}
            onClick={() => void closeVault()}
          >
            ⏏
          </button>
        </div>
      </aside>
      <main className="main">
        {openPath ? (
          <>
            <Editor key={`${vaultId}:${openPath}`} vaultId={vaultId} path={openPath} />
            <BacklinksPanel vaultId={vaultId} path={openPath} />
          </>
        ) : (
          <div className="editor-empty">{t('editor.empty')}</div>
        )}
      </main>
    </>
  );
}

function StatusBar() {
  const { t } = useTranslation();
  const progress = useAppStore((s) => s.indexProgress);
  const vault = useAppStore((s) => s.vault);
  return (
    <footer className="statusbar">
      <span>{vault?.path ?? ''}</span>
      <span className="spacer" />
      {vault && (
        <span>
          {progress
            ? t('status.indexing', { done: progress.done, total: progress.total })
            : t('status.indexed')}
        </span>
      )}
    </footer>
  );
}
