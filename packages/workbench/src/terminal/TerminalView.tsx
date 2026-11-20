import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEffectiveTheme } from '../app/useTheme';
import { fit, focusScreen, mountScreen, themeScreens } from './instances';
import type { TerminalTab } from './model';

interface Props {
  tab: TerminalTab;
  /** The tab is in front and the panel is on the screen: it has a screen and the focus. */
  visible: boolean;
  /** The vault of the session is locked: the output is covered and the keys do not reach it. */
  locked: boolean;
}

/** One tab's screen. The xterm itself is kept outside React (instances.ts); this only parents and sizes it. */
export function TerminalView({ tab, visible, locked }: Props) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const dark = useEffectiveTheme() === 'dark';

  // The screen is made when its tab first shows (a hidden element cannot be measured) and moved
  // here again if the view was rebuilt (a vault change rebuilds the vault view, not the session).
  useEffect(() => {
    const el = host.current;
    if (!visible || !el) return;
    mountScreen(tab.id, el, dark);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit(tab.id));
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // `dark` only matters to a screen that is made now; themeScreens below restyles the others.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tab.id]);

  useEffect(() => themeScreens(dark), [dark]);

  // A tab that comes to the front, or a panel that opens, takes the keyboard.
  useEffect(() => {
    if (visible && !locked) focusScreen(tab.id);
  }, [visible, locked, tab.id]);

  return (
    <div
      className={`terminal-view${visible ? ' active' : ''}`}
      role="tabpanel"
      id={`terminal-panel-${tab.id}`}
      aria-labelledby={`terminal-tab-${tab.id}`}
      hidden={!visible}
    >
      <div className="terminal-host" ref={host} inert={locked} />
      {locked && (
        <div className="terminal-cover" role="status">
          {t('terminal.locked')}
        </div>
      )}
      {tab.exit && (
        <div className="terminal-exit" role="status">
          {tab.exit.reason === 'read-only'
            ? t('terminal.readOnlyClosed')
            : t('terminal.exited', { code: tab.exit.code })}
        </div>
      )}
    </div>
  );
}
