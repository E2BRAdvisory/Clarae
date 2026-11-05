// Full-screen presentation of a .marp file (ADR-0048), over the application window like the
// slideshow of a note: the slides that are not left out, one at a time, the same keys and loop as
// the slideshow of a drawing, a bar with the slide list and the presenter notes. It shows the text
// as it is in the editor (unsaved edits included).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backendFor } from '../reading/ReadingView';
import { moveSlide, slideKey } from '../drawing/slides';
import { Icon } from '../shell/icons';
import { importWithRetry } from '../ui/lazyView';
import { enterFullscreen, leaveFullscreen } from '../util/fullscreen';
import { previewAssets } from './assets';
import { deckSource } from './commands';
import { SHOW_CSS } from './document';
import type { Deck } from './engine';
import { useMarpShow } from './showStore';
import { deckSettings, deckSlides, displayNote, renumberPages } from './slides';

/** The presentation overlay: mounted once by the application, it renders while one is open. */
export function MarpShow() {
  const open = useMarpShow((s) => s.open);
  const vaultId = useMarpShow((s) => s.vaultId);
  const path = useMarpShow((s) => s.path);
  const from = useMarpShow((s) => s.index);
  // Starting again (even the same file) begins a new run.
  return open ? (
    <Running key={`${vaultId}|${path}`} vaultId={vaultId} path={path} from={from} />
  ) : null;
}

function Running({ vaultId, path, from }: { vaultId: string; path: string; from: number }) {
  const { t } = useTranslation();
  const close = useMarpShow((s) => s.close);
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ deck: Deck; source: string } | null>(null);
  const [error, setError] = useState('');
  const [pos, setPos] = useState(0);

  // The text and its slides, rendered once when the presentation starts.
  useEffect(() => {
    let stale = false;
    let held: Deck | null = null;
    void (async () => {
      const source = await deckSource(vaultId, path);
      const { renderDeck } = await importWithRetry(() => import('./engine'));
      const deck = await renderDeck(source, previewAssets(backendFor(vaultId), path));
      if (stale) return deck.release();
      held = deck;
      const first = deck.hidden.findIndex((h, i) => !h && i >= from);
      const order = deck.hidden.flatMap((h, i) => (h ? [] : [i]));
      setPos(Math.max(0, order.indexOf(first)));
      setLoaded({ deck, source });
    })().catch((e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
      held?.release();
    };
  }, [vaultId, path, from]);

  const model = useMemo(() => {
    if (!loaded) return null;
    const slides = deckSlides(loaded.source, loaded.deck.slideLines);
    // Marp's own reading of the file decides what is left out; the model gives the titles.
    const shown = loaded.deck.hidden.flatMap((h, i) => (h ? [] : [i]));
    return {
      deck: loaded.deck,
      settings: deckSettings(loaded.source),
      shown,
      title: (i: number): string => slides[i]?.title || t('marp.panel.untitled', { n: i + 1 }),
    };
  }, [loaded, t]);
  const n = model?.shown.length ?? 0;
  const at = Math.min(pos, Math.max(0, n - 1));
  const slide = model?.shown[at] ?? 0;
  const loop = model?.settings.loop ?? false;

  // The slides go into a shadow root with the theme (both sanitized by renderDeck).
  useEffect(() => {
    const el = host.current;
    if (!el || !model) return;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${model.deck.css}\n${SHOW_CSS}`;
    const body = document.createElement('div');
    body.innerHTML = model.deck.html; // sanitized by sanitizeMarpHtml
    renumberPages(body, model.deck.hidden, model.deck.advances); // the slides left out leave no gap in the page numbers
    shadow.replaceChildren(style, body);
  }, [model]);
  useEffect(() => {
    const svgs = host.current?.shadowRoot?.querySelectorAll('div.marpit > svg') ?? [];
    svgs.forEach((s, i) => s.classList.toggle('current', i === slide));
  }, [model, slide]);

  // Focus and full screen (where the web view allows it); leaving full screen ends the show.
  useEffect(() => {
    const el = root.current;
    el?.focus();
    let entered = false;
    if (el)
      void enterFullscreen(el).then(() => {
        entered = document.fullscreenElement === el;
      });
    const onFullscreen = (): void => {
      if (entered && !document.fullscreenElement) useMarpShow.getState().close();
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      void leaveFullscreen();
    };
  }, []);

  // The keys of the slideshow of a drawing; the application's hotkeys must not see them.
  const stateRef = useRef({ n, loop });
  useEffect(() => {
    stateRef.current = { n, loop };
  });
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // A focused control handles Space and Enter itself.
      if ((e.key === ' ' || e.key === 'Enter') && e.target instanceof HTMLButtonElement) return;
      const k = slideKey(e.key);
      if (k === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      const { n: count, loop: wrap } = stateRef.current;
      if (count === 0) return;
      setPos((i) =>
        k === 'first'
          ? 0
          : k === 'last'
            ? count - 1
            : wrap
              ? (i + k + count) % count
              : moveSlide(i, k, count),
      );
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const step = (k: number): void => setPos((i) => (loop ? (i + k + n) % n : moveSlide(i, k, n)));

  return (
    <div
      ref={root}
      className="marp-show"
      role="dialog"
      aria-modal="true"
      aria-label={t('drawing.slideshow.label')}
      tabIndex={-1}
    >
      <div ref={host} className="marp-show-slides" data-testid="marp-show" />
      {error && (
        <div className="marp-show-message" role="alert">
          {error}
        </div>
      )}
      {model && n === 0 && <div className="marp-show-message">{t('marp.show.empty')}</div>}
      <div className="slideshow-bar" role="toolbar" aria-label={t('drawing.slideshow.label')}>
        {model && n > 0 && (
          <>
            <button
              type="button"
              aria-label={t('drawing.slideshow.previous')}
              disabled={at === 0 && !loop}
              onClick={() => step(-1)}
            >
              <Icon name="prev" />
            </button>
            <select
              aria-label={t('drawing.slideshow.slide')}
              value={at}
              onChange={(e) => setPos(Number(e.target.value))}
            >
              {model.shown.map((i, k) => (
                <option key={i} value={k}>
                  {k + 1}. {model.title(i)}
                </option>
              ))}
            </select>
            <span aria-live="polite">{t('drawing.slideshow.of', { n: at + 1, total: n })}</span>
            {model.settings.notes && model.deck.notes[slide] && (
              <span className="slide-notes">{displayNote(model.deck.notes[slide] ?? '')}</span>
            )}
            <button
              type="button"
              aria-label={t('drawing.slideshow.next')}
              disabled={at === n - 1 && !loop}
              onClick={() => step(1)}
            >
              <Icon name="chevronRight" />
            </button>
          </>
        )}
        <button
          type="button"
          onClick={close}
          aria-label={t('slides.exit')}
          title={t('slides.exit')}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}
