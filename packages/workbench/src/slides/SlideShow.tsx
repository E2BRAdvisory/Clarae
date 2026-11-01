import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SlideView } from './SlideView';
import { useDeck, useSlideHtml } from './useDeck';
import { useSlideshow } from './store';
import { Icon } from '../shell/icons';
import { enterFullscreen, leaveFullscreen } from '../util/fullscreen';

const pad = (n: number): string => String(n).padStart(2, '0');
const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

/** The presentation of a note, over the application window (ADR-0027). */
export function SlideShow() {
  const open = useSlideshow((s) => s.open);
  const vaultId = useSlideshow((s) => s.vaultId);
  const path = useSlideshow((s) => s.path);
  // Starting again (even on the same note) begins a new run: the timer and the focus reset.
  return open ? <Running key={`${vaultId}|${path}`} vaultId={vaultId} path={path} /> : null;
}

function Running({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const index = useSlideshow((s) => s.index);
  const presenter = useSlideshow((s) => s.presenter);
  const setIndex = useSlideshow((s) => s.setIndex);
  const close = useSlideshow((s) => s.close);
  const togglePresenter = useSlideshow((s) => s.togglePresenter);
  const { deck } = useDeck(vaultId, path);
  const html = useSlideHtml(vaultId, path, deck.slides);
  const { config, slides } = deck;
  const n = slides.length;
  const at = Math.min(Math.max(index, 0), Math.max(n - 1, 0));
  const slide = slides[at];

  const direction = useSlideshow((s) => s.direction);
  const startedAt = useSlideshow((s) => s.startedAt);
  const root = useRef<HTMLDivElement>(null);

  const go = (i: number): void => setIndex(Math.min(Math.max(i, 0), Math.max(n - 1, 0)));

  // Focus, full screen (where the web view allows it), and leaving it with the browser's own Esc.
  useEffect(() => {
    const el = root.current;
    el?.focus();
    let entered = false;
    if (el)
      void enterFullscreen(el).then(() => {
        entered = document.fullscreenElement === el;
      });
    const onFullscreen = (): void => {
      if (entered && !document.fullscreenElement) useSlideshow.getState().close();
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      void leaveFullscreen();
    };
  }, []);

  // Timer of the presenter view.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!presenter) return;
    const tick = (): void => setElapsed(Date.now() - startedAt);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [presenter, startedAt]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A focused button handles Space/Enter itself.
    if ((e.key === ' ' || e.key === 'Enter') && e.target instanceof HTMLButtonElement) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
      case ' ':
      case 'Enter':
        go(at + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
      case 'Backspace':
        go(at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(n - 1);
        break;
      case 'p':
      case 'P':
        togglePresenter();
        break;
      case 'Escape':
        close();
        break;
      default:
        return;
    }
    e.preventDefault(); // handled here: the application's hotkeys must not see it
  };

  const animation =
    config.transition === 'none' ? '' : `anim-${config.transition} dir-${direction}`;
  const counter = n > 0 ? t('slides.counter', { current: at + 1, total: n }) : '';

  return (
    <div
      ref={root}
      className={`deck-show${presenter ? ' presenter' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('slides.presentation')}
      tabIndex={-1}
      onKeyDown={onKey}
    >
      <div className="deck-bar">
        <button
          type="button"
          onClick={() => go(at - 1)}
          disabled={at === 0}
          aria-label={t('slides.previous')}
          title={t('slides.previous')}
        >
          <Icon name="prev" />
        </button>
        <button
          type="button"
          onClick={() => go(at + 1)}
          disabled={at >= n - 1}
          aria-label={t('slides.next')}
          title={t('slides.next')}
        >
          <Icon name="chevronRight" />
        </button>
        <button
          type="button"
          aria-pressed={presenter}
          onClick={togglePresenter}
          title={t('slides.presenterView')}
          aria-label={t('slides.presenterView')}
        >
          <Icon name="grid" />
        </button>
        <button
          type="button"
          onClick={close}
          aria-label={t('slides.exit')}
          title={t('slides.exit')}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {counter}
      </span>

      {n === 0 && <div className="deck-empty">{t('slides.none')}</div>}

      {n > 0 && !presenter && (
        <div className="slide-stage" onClick={() => go(at + 1)}>
          <div key={at} className={`slide-anim ${animation}`}>
            <SlideView html={html[at]} theme={config.theme} openLinks />
          </div>
          {config.numbers && <div className="slide-number">{counter}</div>}
        </div>
      )}

      {n > 0 && presenter && (
        <div className="presenter-grid">
          <div className="presenter-current">
            <SlideView html={html[at]} theme={config.theme} openLinks />
          </div>
          <div className="presenter-side">
            <div className="presenter-next" aria-label={t('slides.next')}>
              {at + 1 < n ? (
                <SlideView html={html[at + 1]} theme={config.theme} />
              ) : (
                <div className="muted pad">{t('slides.last')}</div>
              )}
            </div>
            <div className="presenter-meta">
              <span>{counter}</span>
              <span aria-label={t('slides.elapsed')}>{clock(elapsed)}</span>
            </div>
            {config.notes && (
              <div className="presenter-notes" aria-label={t('slides.notes')}>
                {slide?.notes ? slide.notes : <span className="muted">{t('slides.noNotes')}</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {config.progress && n > 0 && (
        <div className="slide-progress" role="presentation">
          <div style={{ width: `${((at + 1) / n) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
