import { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { applyTheme, type Theme } from '../app/theme';
import { commandForEvent } from '../commands/registry';
import { initI18n } from '../i18n';
import { useSettings } from '../state/settings';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { startTerminal } from './controller';
import { LazyTerminalPanel } from './lazy';
import { activeTab, useTerminal } from './store';
import { setWindowTitle } from './title';

/**
 * The page of the separate terminal window (terminal.html): the terminal panel and nothing else. It holds
 * the panel while the core says `detached` and draws what it lists; the main window holds it otherwise.
 * It knows no vault of its own: a new tab opens in the vault of the front one, a locked vault covers its
 * tabs, and the hotkeys the user set are those of the vault of the front tab (none for a tab in the home directory).
 */
export function TerminalWindow() {
  const { t } = useTranslation();
  // Language and theme are the application's own (the settings of the device, not a vault's).
  useEffect(() => {
    void api.settings.get().then((s) => {
      applyTheme((s.theme || 'system') as Theme);
      initI18n(s.language || undefined);
    });
  }, []);

  useEffect(() => startTerminal('window'), []);

  // The title of the window is in the language of the application (the core's is fixed).
  const title = `${t('app.name')} — ${t('terminal.title')}`;
  useEffect(() => setWindowTitle(title), [title]);

  // The hotkeys of the vault of the front tab, as the main window has them while that vault is open.
  const vaultId = useTerminal((s) => activeTab(s)?.vaultId ?? '');
  useEffect(() => {
    if (vaultId && useSettings.getState().vaultId !== vaultId)
      void useSettings
        .getState()
        .load(vaultId)
        .catch(() => undefined);
  }, [vaultId]);

  // The terminal's keys work here too (the application's other hotkeys belong to the main window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const c = commandForEvent(e, useSettings.getState().hotkeys, (x) =>
        x.id.startsWith('terminal:'),
      );
      if (!c) return;
      e.preventDefault();
      void c.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="terminal-window">
      <ErrorBoundary scope="view">
        <Suspense fallback={<div className="terminal-loading" aria-busy="true" />}>
          <LazyTerminalPanel />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
