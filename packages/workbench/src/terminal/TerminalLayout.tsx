import {
  Suspense,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useCan } from '../platform';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { setDock } from './controller';
import { LazyTerminalPanel } from './lazy';
import { clampSize, DOCK_MAX, DOCK_MIN, type DockPosition } from './dock';
import { panelVisible, useTerminal } from './store';

/** What the splitter moves: the size that grows when the pointer goes towards the work area. */
const grows = (position: DockPosition, dx: number, dy: number): number =>
  position === 'bottom' ? -dy : position === 'left' ? dx : -dx;

/** The most room the panel may take: the area keeps a part of its own. */
const keep = 160;

/**
 * The work area of the main window and, next to it, the terminal panel (below, left or right, as the
 * user chose). Hiding the panel does not unmount it, so its screens and their scrollback stay.
 */
export function TerminalLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const terminal = useCan('terminal');
  const visible = useTerminal(panelVisible);
  const { position, size } = useTerminal((s) => s.dock);
  const area = useRef<HTMLDivElement>(null);
  // Loaded on the first show, then kept mounted (hidden) so that nothing is redrawn.
  const [shown, setShown] = useState(false);
  if (visible && !shown) setShown(true);

  const limit = (): number => {
    const r = area.current?.getBoundingClientRect();
    const total = r ? (position === 'bottom' ? r.height : r.width) : 0;
    const room = total > 0 ? total - keep : DOCK_MAX; // not laid out yet: no limit but the largest
    return Math.max(DOCK_MIN, Math.min(DOCK_MAX, room));
  };

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const initial = size;
    const max = limit();
    const move = (ev: globalThis.PointerEvent): void => {
      const next = initial + grows(position, ev.clientX - startX, ev.clientY - startY);
      setDock({ size: Math.min(max, clampSize(next)) }, false);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDock({}); // remember where it ended
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // The splitter is a control for the keyboard too: the arrows towards the work area grow the panel.
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16;
    const toward = { bottom: 'ArrowUp', left: 'ArrowRight', right: 'ArrowLeft' }[position];
    const away = { bottom: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[position];
    if (e.key !== toward && e.key !== away) return;
    e.preventDefault();
    setDock({ size: Math.min(limit(), clampSize(size + (e.key === toward ? step : -step))) });
  };

  // A host that cannot run processes (the browser) keeps its layout as it is.
  if (!terminal) return <>{children}</>;
  return (
    <div className={`terminal-layout ${position}`} ref={area}>
      <div className="terminal-work">{children}</div>
      {(shown || visible) && (
        <aside
          className={`terminal-dock ${position}`}
          hidden={!visible}
          style={position === 'bottom' ? { height: size } : { width: size }}
        >
          <div
            className="terminal-resizer"
            role="separator"
            tabIndex={0}
            aria-label={t('terminal.resize')}
            aria-orientation={position === 'bottom' ? 'horizontal' : 'vertical'}
            aria-valuemin={DOCK_MIN}
            aria-valuemax={DOCK_MAX}
            aria-valuenow={size}
            onPointerDown={onDown}
            onKeyDown={onKey}
          />
          <ErrorBoundary scope="view" resetKey={position}>
            <Suspense fallback={<div className="terminal-loading" aria-busy="true" />}>
              <LazyTerminalPanel />
            </Suspense>
          </ErrorBoundary>
        </aside>
      )}
    </div>
  );
}
