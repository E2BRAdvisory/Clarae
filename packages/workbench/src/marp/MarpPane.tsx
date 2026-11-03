// Live preview of a .marp file (ADR-0047), the right half of its split view: the slides rendered by
// Marp, kept in a shadow root so that the theme's stylesheet styles them and nothing else, the slide
// under the editor's cursor highlighted, a click on a slide moving the cursor there, and presenting
// (one slide filling the screen, keys to move). Loaded on demand with the renderer.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backendFor } from '../reading/ReadingView';
import { previewAssets } from './assets';
import { exportDeckHtml, exportDeckPdf, exportDeckPptx } from './commands';
import { PREVIEW_CSS } from './document';
import { renderDeck, slideAt, type Deck } from './engine';
import { registerPresenter } from './presenter';

/** Pause in typing before the slides are rendered again. */
const RENDER_DELAY_MS = 150;

interface Props {
  vaultId: string;
  path: string;
  /** The text of the editor (unsaved edits included). */
  source: string;
  /** 0-based line of the editor's cursor. */
  cursorLine: number;
  /** A slide was clicked: the 0-based line where it starts. */
  onPickSlide: (line: number) => void;
}

export function MarpPane({ vaultId, path, source, cursorLine, onPickSlide }: Props) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState('');
  const [presenting, setPresenting] = useState<number | null>(null);
  const deckRef = useRef<Deck | null>(null);

  // Render after typing pauses; a newer render replaces (and releases) the older one.
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      renderDeck(source, previewAssets(backendFor(vaultId), path)).then(
        (next) => {
          if (stale) return next.release();
          deckRef.current?.release();
          deckRef.current = next;
          setDeck(next);
          setError('');
        },
        (e: unknown) => !stale && setError(e instanceof Error ? e.message : String(e)),
      );
    }, RENDER_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [vaultId, path, source]);
  useEffect(() => () => deckRef.current?.release(), []);

  // The slides go into the shadow root with the theme (both sanitized by renderDeck).
  useEffect(() => {
    const el = host.current;
    if (!el || !deck) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${deck.css}\n${PREVIEW_CSS}`;
    const body = document.createElement('div');
    body.innerHTML = deck.html; // sanitized by sanitizeMarpHtml
    root.replaceChildren(style, body);
  }, [deck]);

  const slides = (): SVGSVGElement[] => [
    ...(host.current?.shadowRoot?.querySelectorAll<SVGSVGElement>('div.marpit > svg') ?? []),
  ];
  const current = presenting ?? (deck ? slideAt(deck.slideLines, cursorLine) : 0);

  // The current slide is marked (and brought into view while editing).
  useEffect(() => {
    const all = slides();
    all.forEach((s, i) => s.classList.toggle('current', i === current));
    if (presenting === null) all[current]?.scrollIntoView?.({ block: 'nearest' });
  }, [deck, current, presenting]);

  // A click on a slide moves the editor's cursor to it.
  useEffect(() => {
    const root = host.current?.shadowRoot;
    if (!root || !deck) return;
    const onClick = (e: Event): void => {
      if (presenting !== null) return;
      const svg = (e.target as Element).closest?.('div.marpit > svg');
      const i = svg ? slides().indexOf(svg as SVGSVGElement) : -1;
      const line = deck.slideLines[i];
      if (line !== undefined) onPickSlide(line);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [deck, presenting, onPickSlide]);

  // Presenting: the host covers the window (full screen when the web view allows it).
  useEffect(
    () =>
      registerPresenter(path, () => {
        if (!deckRef.current) return;
        setPresenting(0);
        void host.current?.requestFullscreen?.().catch(() => undefined);
      }),
    [path],
  );
  useEffect(() => {
    const el = host.current;
    if (!el || presenting === null) return;
    el.classList.add('presenting');
    const count = slides().length;
    const stop = (): void => {
      if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
      setPresenting(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      const step: Record<string, number> = {
        ArrowRight: 1,
        ArrowDown: 1,
        PageDown: 1,
        ' ': 1,
        Enter: 1,
        ArrowLeft: -1,
        ArrowUp: -1,
        PageUp: -1,
        Backspace: -1,
      };
      if (e.key === 'Escape') stop();
      else if (e.key === 'Home') setPresenting(0);
      else if (e.key === 'End') setPresenting(Math.max(0, count - 1));
      else if (step[e.key] !== undefined)
        setPresenting((p) => Math.min(count - 1, Math.max(0, (p ?? 0) + (step[e.key] ?? 0))));
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // Leaving full screen with the browser's own Escape ends the presentation too.
    const onFullscreen = (): void => {
      if (document.fullscreenElement !== el) setPresenting(null);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      el.classList.remove('presenting');
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [presenting !== null]); // eslint-disable-line react-hooks/exhaustive-deps -- set up once per presentation

  return (
    <div className="marp-pane">
      <div className="marp-toolbar" role="toolbar" aria-label={t('marp.toolbar')}>
        <button
          onClick={() => {
            if (!deckRef.current) return;
            setPresenting(0);
            void host.current?.requestFullscreen?.().catch(() => undefined);
          }}
          disabled={!deck}
        >
          {t('marp.present')}
        </button>
        <span className="spacer" />
        <button onClick={() => void exportDeckHtml()}>{t('marp.exportHtml')}</button>
        <button onClick={() => void exportDeckPdf()}>{t('marp.exportPdf')}</button>
        <button
          onClick={() => void exportDeckPptx()}
          aria-disabled="true"
          className="unavailable"
          title={t('marp.pptxLater')}
        >
          {t('marp.exportPptx')}
        </button>
      </div>
      {error && (
        <div className="marp-error" role="alert">
          {error}
        </div>
      )}
      <div
        ref={host}
        className="marp-slides"
        data-testid="marp-slides"
        aria-label={t('marp.preview')}
        role="region"
      />
    </div>
  );
}

export default MarpPane;
