import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AuthState, type SyncStatus } from './api';
import {
  Events,
  type FileChangedPayload,
  type IndexProgressPayload,
  type OpenRequestPayload,
  type SyncConflictPayload,
  type VaultLockedPayload,
} from './events';
import { applyTheme, type Theme } from './theme';
import { initI18n } from '../i18n';
import { selectActivePath, useAppStore, type LeftTab, type RightTab } from '../state/store';
import { applyAppearance, useSettings } from '../state/settings';
import { useInvalidate, useRecentVaults } from '../state/queries';
import { allPanes, parseLayout, removePath } from '../workspace/layout';
import { WorkspaceView } from '../workspace/WorkspaceView';
import { FileExplorer } from '../sidebar/FileExplorer';
import { TagsPanel } from '../sidebar/TagsPanel';
import { OutlinePanel } from '../sidebar/OutlinePanel';
import { BacklinksPanel } from '../sidebar/BacklinksPanel';
import { PropertiesPanel } from '../sidebar/PropertiesPanel';
import { SearchPanel } from '../search/SearchPanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { CommandPalette } from '../commands/CommandPalette';
import { QuickSwitcher } from '../commands/QuickSwitcher';
import { commandForEvent } from '../commands/registry';
import { DialogHost, dialog } from '../ui/dialogs';
import { infoOf, useSync } from '../state/sync';
import { SyncDialogs } from '../sync/SyncDialogs';
import { SyncIndicator } from '../sync/SyncIndicator';
import { SharingDialogs } from '../sharing/SharingDialogs';
import { InvitesIndicator, PermissionBadge } from '../sharing/StatusItems';
import { followLinkPath } from './open';

const LEFT_TABS: LeftTab[] = ['files', 'search', 'tags'];
const RIGHT_TABS: RightTab[] = ['outline', 'backlinks', 'properties'];

export function App() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const setVault = useAppStore((s) => s.setVault);
  const setSettings = useAppStore((s) => s.setSettings);
  const setAuth = useAppStore((s) => s.setAuth);
  const setIndexProgress = useAppStore((s) => s.setIndexProgress);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const appearance = useSettings((s) => s.appearance);
  const invalidate = useInvalidate();

  // Load preferences once.
  useEffect(() => {
    void api.settings.get().then((s) => {
      setSettings(s);
      applyTheme((s.theme || 'system') as Theme);
      initI18n(s.language || undefined);
    });
  }, [setSettings]);

  useEffect(() => applyAppearance(appearance), [appearance]);

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
      void invalidate.tags(p.vaultId);
      void invalidate.propkeys(p.vaultId);
      void invalidate.outline(p.vaultId);
    });
    const offIndex = api.on<IndexProgressPayload>(Events.indexProgress, (p) => {
      setIndexProgress(p.finished ? null : p);
      if (p.finished) {
        void invalidate.search(p.vaultId);
        void invalidate.tags(p.vaultId);
        void invalidate.propkeys(p.vaultId);
      }
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
      await dialog.error(e);
    }
  };

  // Cloud synchronization: status and conflicts are pushed by the backend.
  useEffect(() => {
    const offStatus = api.on<SyncStatus>(Events.syncStatus, (s) => useSync.getState().setStatus(s));
    const offConflict = api.on<SyncConflictPayload>(
      Events.syncConflict,
      (p) => void useSync.getState().refreshConflicts(p.vaultId),
    );
    const offLocked = api.on<VaultLockedPayload>(Events.vaultLocked, (p) => {
      if (p.vaultId === useAppStore.getState().vault?.id) useSync.getState().setUnlockOpen(true);
    });
    return () => {
      offStatus();
      offConflict();
      offLocked();
    };
  }, []);

  const vaultId = vault?.id;
  const syncInfo = useSync((s) => infoOf(s, vaultId));
  useEffect(() => {
    if (vaultId) void useSync.getState().refresh(vaultId);
  }, [vaultId]);
  useEffect(() => {
    if (syncInfo.linked && syncInfo.kind === 'private') void useSync.getState().checkDisk();
    if (syncInfo.linked && syncInfo.locked) useSync.getState().setUnlockOpen(true);
  }, [syncInfo.linked, syncInfo.kind, syncInfo.locked]);

  // nodus://open?vault=…&file=… (from the OS or another instance).
  useEffect(
    () =>
      api.on<OpenRequestPayload>(Events.openRequest, (p) => {
        void followLinkPath(p, openVault);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Application hotkeys. Editors handle theirs first (they call preventDefault).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const c = commandForEvent(e, useSettings.getState().hotkeys);
      if (!c) return;
      e.preventDefault();
      void c.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="title">{vault ? vault.name : t('app.name')}</span>
        <span className="spacer" />
        {vault && (
          <button
            className="icon"
            title={t('commands.palette_open')}
            aria-label={t('commands.palette_open')}
            onClick={() => useAppStore.getState().setPaletteOpen(true)}
          >
            ⌘
          </button>
        )}
        <button
          className="icon"
          title={t('settings.title')}
          aria-label={t('settings.title')}
          onClick={() => useAppStore.getState().openSettings()}
        >
          ⚙
        </button>
      </header>
      {vault ? <VaultView key={vault.id} vaultId={vault.id} /> : <Welcome onOpen={openVault} />}
      <StatusBar />
      {settingsOpen && <SettingsPanel />}
      <SyncDialogs />
      <SharingDialogs />
      <CommandPalette />
      <QuickSwitcher />
      <DialogHost />
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

/** Loads per-vault settings and the saved workspace, then keeps the workspace saved. */
function useVaultSession(vaultId: string): boolean {
  const ready = useRef(false);
  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    void (async () => {
      await useSettings.getState().load(vaultId);
      try {
        const saved = JSON.parse(
          (await api.vault.readConfig(vaultId, 'workspace.json')) || 'null',
        ) as Record<string, unknown> | null;
        const layout = saved ? parseLayout(saved['layout']) : null;
        if (layout && !cancelled) {
          // Forget tabs whose file has disappeared since the last session.
          const tree = new Set((await api.vault.listTree(vaultId)).map((e) => e.path));
          let next = layout;
          for (const p of allPanes(layout.root))
            for (const tab of p.tabs) if (!tree.has(tab.path)) next = removePath(next, tab.path);
          useAppStore.getState().setLayout(next);
          const l = saved?.['left'] as
            { open?: boolean; tab?: LeftTab; width?: number } | undefined;
          const r = saved?.['right'] as
            { open?: boolean; tab?: RightTab; width?: number } | undefined;
          if (l)
            useAppStore.getState().setLeft({
              ...(typeof l.open === 'boolean' ? { open: l.open } : {}),
              ...(l.tab && LEFT_TABS.includes(l.tab)
                ? { tab: l.tab === 'search' ? 'files' : l.tab }
                : {}),
              ...(typeof l.width === 'number'
                ? { width: Math.min(600, Math.max(180, l.width)) }
                : {}),
            });
          if (r)
            useAppStore.getState().setRight({
              ...(typeof r.open === 'boolean' ? { open: r.open } : {}),
              ...(r.tab && RIGHT_TABS.includes(r.tab) ? { tab: r.tab } : {}),
              ...(typeof r.width === 'number'
                ? { width: Math.min(600, Math.max(180, r.width)) }
                : {}),
            });
        }
      } catch {
        // No or unreadable workspace file: start with an empty workspace.
      }
      ready.current = true;
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useAppStore.subscribe((s, prev) => {
      if (
        !ready.current ||
        (s.layout === prev.layout && s.left === prev.left && s.right === prev.right)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const st = useAppStore.getState();
        void api.vault
          .writeConfig(
            vaultId,
            'workspace.json',
            JSON.stringify({ layout: st.layout, left: st.left, right: st.right }),
          )
          .catch(() => undefined);
      }, 500);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsub();
      useSettings.getState().reset();
    };
  }, [vaultId]);
  return ready.current;
}

function SidebarTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly T[];
  value: T;
  onChange: (t: T) => void;
  label: (t: T) => string;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={value === tab}
          className={value === tab ? 'active' : ''}
          onClick={() => onChange(tab)}
        >
          {label(tab)}
        </button>
      ))}
    </div>
  );
}

function SidebarResizer({ side }: { side: 'left' | 'right' }) {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const st = useAppStore.getState();
    const start = e.clientX;
    const initial = side === 'left' ? st.left.width : st.right.width;
    const move = (ev: PointerEvent): void => {
      const delta = side === 'left' ? ev.clientX - start : start - ev.clientX;
      const width = Math.min(600, Math.max(180, initial + delta));
      if (side === 'left') useAppStore.getState().setLeft({ width });
      else useAppStore.getState().setRight({ width });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`sidebar-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onDown}
    />
  );
}

function VaultView({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  useVaultSession(vaultId);
  const left = useAppStore((s) => s.left);
  const right = useAppStore((s) => s.right);
  const setLeft = useAppStore((s) => s.setLeft);
  const setRight = useAppStore((s) => s.setRight);
  const activePath = useAppStore(selectActivePath);

  return (
    <div
      className="vault"
      style={{
        gridTemplateColumns: `${left.open ? left.width : 0}px 1fr ${right.open ? right.width : 0}px`,
      }}
    >
      {left.open ? (
        <aside className="sidebar left" aria-label={t('sidebar.left')}>
          <SidebarTabs
            tabs={LEFT_TABS}
            value={left.tab}
            onChange={(tab) => setLeft({ tab })}
            label={(tab) => t(`sidebar.${tab}`)}
          />
          {left.tab === 'files' && <FileExplorer vaultId={vaultId} />}
          {left.tab === 'search' && <SearchPanel vaultId={vaultId} />}
          {left.tab === 'tags' && <TagsPanel vaultId={vaultId} />}
          <SidebarResizer side="left" />
        </aside>
      ) : (
        <div />
      )}
      <main className="main">
        <WorkspaceView vaultId={vaultId} />
      </main>
      {right.open ? (
        <aside className="sidebar right" aria-label={t('sidebar.right')}>
          <SidebarTabs
            tabs={RIGHT_TABS}
            value={right.tab}
            onChange={(tab) => setRight({ tab })}
            label={(tab) => t(`sidebar.${tab}`)}
          />
          {right.tab === 'outline' && <OutlinePanel vaultId={vaultId} />}
          {right.tab === 'backlinks' &&
            (activePath ? (
              <BacklinksPanel vaultId={vaultId} path={activePath} />
            ) : (
              <div className="muted pad">{t('outline.none')}</div>
            ))}
          {right.tab === 'properties' && <PropertiesPanel vaultId={vaultId} />}
          <SidebarResizer side="right" />
        </aside>
      ) : (
        <div />
      )}
    </div>
  );
}

function StatusBar() {
  const { t } = useTranslation();
  const progress = useAppStore((s) => s.indexProgress);
  const vault = useAppStore((s) => s.vault);
  const stats = useAppStore((s) => s.stats);
  const hasNote = useAppStore((s) => selectActivePath(s) !== null);
  const setLeft = useAppStore((s) => s.setLeft);
  const setRight = useAppStore((s) => s.setRight);
  return (
    <footer className="statusbar">
      {vault && (
        <>
          <button
            className="icon"
            title={t('commands.sidebar_left')}
            aria-label={t('commands.sidebar_left')}
            onClick={() => setLeft({ open: !useAppStore.getState().left.open })}
          >
            ◧
          </button>
          <span className="path">{vault.path}</span>
        </>
      )}
      <span className="spacer" />
      {hasNote && stats && (
        <>
          <span>{t('status.position', { line: stats.line, col: stats.col })}</span>
          <span>
            {stats.selChars > 0
              ? t('status.selection', { words: stats.selWords, chars: stats.selChars })
              : t('status.words', { count: stats.words })}
          </span>
          <span>{t('status.chars', { count: stats.chars })}</span>
        </>
      )}
      <PermissionBadge />
      <SyncIndicator />
      <InvitesIndicator />
      {vault && (
        <span>
          {progress
            ? t('status.indexing', { done: progress.done, total: progress.total })
            : t('status.indexed')}
        </span>
      )}
      {vault && (
        <button
          className="icon"
          title={t('commands.sidebar_right')}
          aria-label={t('commands.sidebar_right')}
          onClick={() => setRight({ open: !useAppStore.getState().right.open })}
        >
          ◨
        </button>
      )}
    </footer>
  );
}
