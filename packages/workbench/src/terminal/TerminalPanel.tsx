import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { commandById, isEnabled, runCommand } from '../commands/registry';
import { Icon } from '../shell/icons';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import {
  activateTab,
  closeTab,
  dismissNotice,
  newTerminalTab,
  setDock,
  stepTab,
} from './controller';
import { canStartTerminal } from './commands';
import { DOCK_POSITIONS, type DockPosition } from './dock';
import { panelVisible, useTerminal } from './store';
import { TerminalView } from './TerminalView';

/**
 * The terminal: a bar with the tabs, the new-tab button, where the panel sits (in the main window) and the
 * button that moves it to its own window (or back); under it the screen of the front tab. The main window
 * and the separate one (terminal.html) show this same component.
 */
export function TerminalPanel() {
  const { t } = useTranslation();
  const role = useTerminal((s) => s.role);
  const tabs = useTerminal((s) => s.tabs);
  const active = useTerminal((s) => s.active);
  const visible = useTerminal(panelVisible);
  const position = useTerminal((s) => s.dock.position);
  const locked = useTerminal((s) => s.locked);
  const notice = useTerminal((s) => s.notice);
  // Whether a command is enabled depends on these; subscribing re-evaluates it on change.
  useTerminal((s) => s.mode);
  useAppStore((s) => s.vault);
  useSync((s) => s.info);

  const enabled = (id: string): boolean => {
    const c = commandById.get(id);
    return !!c && isEnabled(c);
  };
  const dockCommand = role === 'main' ? 'terminal:undock' : 'terminal:dock';
  const dockLabel = t(role === 'main' ? 'terminal.undock' : 'terminal.dock');
  const newDisabled = !canStartTerminal();

  // Roving tabindex, as the tabs of the editor: arrows move between tabs, Delete closes one.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    const target = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Delete') {
      e.preventDefault();
      closeTab(id);
      return;
    }
    if (!target) return;
    e.preventDefault();
    stepTab(target);
    const buttons = e.currentTarget.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]');
    const i = tabs.findIndex((x) => x.id === id);
    const next = (i + target + tabs.length) % tabs.length;
    requestAnimationFrame(() => (buttons?.[next] as HTMLElement | undefined)?.focus());
  };

  return (
    <section className={`terminal-panel ${role}`} aria-label={t('terminal.title')}>
      <div className="terminal-bar">
        <div role="tablist" className="terminal-tabs" aria-label={t('terminal.tabs')}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="presentation"
              className={`terminal-tab${tab.id === active ? ' active' : ''}${tab.exit ? ' ended' : ''}`}
            >
              <button
                type="button"
                role="tab"
                id={`terminal-tab-${tab.id}`}
                className="terminal-tab-title"
                aria-selected={tab.id === active}
                aria-controls={`terminal-panel-${tab.id}`}
                tabIndex={tab.id === active ? 0 : -1}
                title={tab.cwd}
                onClick={() => activateTab(tab.id)}
                onKeyDown={(e) => onTabKey(e, tab.id)}
              >
                {tab.title}
              </button>
              <button
                type="button"
                className="icon close"
                tabIndex={-1}
                // A tablist holds only tabs for assistive technology: Delete on the tab closes it.
                aria-hidden="true"
                title={t('terminal.closeTab', { title: tab.title })}
                onClick={() => closeTab(tab.id)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="icon terminal-new"
          title={t(newDisabled ? 'terminal.newTabReadOnly' : 'terminal.newTab')}
          aria-label={t('terminal.newTab')}
          disabled={newDisabled}
          onClick={() => void newTerminalTab()}
        >
          <Icon name="plus" />
        </button>
        <span className="spacer" />
        {role === 'main' && (
          <select
            className="terminal-position"
            aria-label={t('terminal.position')}
            title={t('terminal.position')}
            value={position}
            onChange={(e) => setDock({ position: e.target.value as DockPosition })}
          >
            {DOCK_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {t(`terminal.positions.${p}`)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="icon terminal-dock-button"
          title={dockLabel}
          aria-label={dockLabel}
          disabled={!enabled(dockCommand)}
          onClick={() => void runCommand(dockCommand)}
        >
          <Icon name={role === 'main' ? 'undock' : 'dock'} />
        </button>
      </div>
      {notice && (
        <div className="terminal-notice" role="alert">
          <span>{notice}</span>
          <button
            type="button"
            className="icon"
            title={t('terminal.dismiss')}
            aria-label={t('terminal.dismiss')}
            onClick={dismissNotice}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      <div className="terminal-body">
        {tabs.length === 0 && <p className="terminal-empty muted">{t('terminal.empty')}</p>}
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            tab={tab}
            visible={visible && tab.id === active}
            locked={!!tab.vaultId && !!locked[tab.vaultId]}
          />
        ))}
      </div>
    </section>
  );
}
