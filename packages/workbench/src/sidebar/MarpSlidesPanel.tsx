// Right sidebar, "Slideshow" tab for a Marp presentation (ADR-0048): the same panel as a drawing's.
// Every slide is a card (title, thumbnail, notes); the panel starts, prints and describes the
// presentation, sets its options, moves slides, leaves them out and keeps their presenter notes.
// All of it is text in the .marp file: each action is one transaction of its editor (one undo step).
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { SourceEdit } from '../editor/types';
import { backendFor } from '../reading/ReadingView';
import { importWithRetry } from '../ui/lazyView';
import { Icon } from '../shell/icons';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { previewAssets } from '../marp/assets';
import { exportDeckPdf } from '../marp/commands';
import { applyEdit, goToSlide, type EditResult } from '../marp/controller';
import { useMarpDeck } from '../marp/deckStore';
import { THUMB_CSS } from '../marp/document';
import type { Deck } from '../marp/engine';
import { useMarpShow } from '../marp/showStore';
import {
  canReorder,
  deckSettings,
  deckSlides,
  displayNote,
  frontmatterEdit,
  LOOP_KEY,
  NOTES_KEY,
  moveSlideEdit,
  notesEdit,
  setHiddenEdit,
  slideAt,
  type DeckSlide,
} from '../marp/slides';

/** Pause in typing before the thumbnails are rendered again. */
const RENDER_DELAY_MS = 150;
/** Pause in typing in the notes box before they are written into the file. */
const NOTES_DELAY_MS = 600;
const THEMES = ['default', 'gaia', 'uncover'] as const;

interface Rendered {
  path: string;
  source: string;
  deck: Deck;
  /** One `<svg>` (sanitized) per slide. */
  svgs: string[];
}

/** Renders the slides of the source after typing pauses; a newer render replaces the older one. */
function useRenderedDeck(vaultId: string, path: string, source: string): Rendered | null {
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const held = useRef<Deck | null>(null);
  useEffect(() => {
    if (!source) return;
    let stale = false;
    const timer = setTimeout(() => {
      void (async () => {
        const { renderDeck } = await importWithRetry(() => import('../marp/engine'));
        const deck = await renderDeck(source, previewAssets(backendFor(vaultId), path));
        if (stale) return deck.release();
        const doc = new DOMParser().parseFromString(deck.html, 'text/html');
        const svgs = [...doc.querySelectorAll('div.marpit > svg')].map((s) => s.outerHTML);
        held.current?.release();
        held.current = deck;
        setRendered({ path, source, deck, svgs });
      })().catch(() => undefined);
    }, RENDER_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [vaultId, path, source]);
  useEffect(
    () => () => {
      held.current?.release();
      held.current = null;
    },
    [],
  );
  return rendered?.path === path ? rendered : null;
}

/** The thumbnail of a slide: its `<svg>` in a shadow root with the theme (nothing else sees it). */
function Thumb({ svg, css }: { svg: string; css: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${css}\n${THUMB_CSS}`;
    const body = document.createElement('div');
    body.className = 'marpit';
    body.innerHTML = svg; // sanitized by renderDeck
    root.replaceChildren(style, body);
  }, [svg, css]);
  return <div ref={host} className="slide-thumb" />;
}

/** How many times a note is offered to the editor again when its text moved on meanwhile. */
const NOTES_MAX_RETRIES = 5;

/**
 * Presenter notes of one slide: written into the file 600 ms after typing stops, or at once when the
 * card closes or the panel acts on the file (`flush`, which tells whether it wrote something).
 */
function Notes({
  slide,
  editable,
  save,
  flushRef,
}: {
  slide: DeckSlide;
  editable: boolean;
  save: (index: number, text: string) => EditResult;
  flushRef: MutableRefObject<(() => boolean) | null>;
}) {
  const { t } = useTranslation();
  // The invisible character that keeps a note from being read as a directive is not shown.
  const shown = displayNote(slide.notes);
  const [text, setText] = useState(shown);
  const saved = useRef(shown);
  const latest = useRef({ text, index: slide.index, editable, save });
  useEffect(() => {
    latest.current = { text, index: slide.index, editable, save };
  });
  useEffect(() => {
    // Changed elsewhere (undo, another slide moved here): follow it unless the user is typing.
    if (shown !== saved.current) {
      saved.current = shown;
      setText(shown);
    }
  }, [shown]);
  useEffect(() => {
    if (text.trim() === saved.current || !editable) return;
    let timer: ReturnType<typeof setTimeout>;
    let tries = 0;
    const attempt = (delay: number): void => {
      timer = setTimeout(() => {
        // Not applied when the editor moved on meanwhile: try again with the new text, a few times.
        const l = latest.current;
        if (l.save(l.index, l.text)) saved.current = l.text.trim();
        else if (++tries < NOTES_MAX_RETRIES) attempt(300);
      }, delay);
    };
    attempt(NOTES_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, slide.index, editable]);
  useEffect(() => {
    const write = (): boolean => {
      const l = latest.current;
      if (!l.editable || l.text.trim() === saved.current) return false;
      const done = l.save(l.index, l.text);
      if (!done) return false;
      saved.current = l.text.trim();
      return done === 'changed'; // a rewrite that changes nothing leaves no re-render to wait for
    };
    flushRef.current = write;
    useMarpDeck.setState({ flushNotes: write });
    return () => {
      if (flushRef.current === write) flushRef.current = null;
      if (useMarpDeck.getState().flushNotes === write) useMarpDeck.setState({ flushNotes: null });
      write(); // the card closed within the delay: the notes are not lost
    };
  }, [flushRef]);
  return (
    <>
      <label className="slide-notes-label" htmlFor={`marp-notes-${slide.index}`}>
        {t('drawing.slidePanel.notes')}
      </label>
      <textarea
        id={`marp-notes-${slide.index}`}
        value={text}
        readOnly={!editable}
        placeholder={t('drawing.slidePanel.notesPlaceholder')}
        onChange={(e) => setText(e.target.value)}
      />
      <small className="muted">{t('drawing.slidePanel.notesHint')}</small>
    </>
  );
}

type Panel = 'settings' | 'info' | null;

export function MarpSlidesPanel({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const mine = useMarpDeck((s) => s.path === path && s.vaultId === vaultId);
  const source = useMarpDeck((s) => (s.path === path ? s.source : ''));
  const cursorLine = useMarpDeck((s) => s.cursorLine);
  const readOnly = useMarpDeck((s) => s.readOnly);
  const rendered = useRenderedDeck(vaultId, path, mine ? source : '');
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  // The cards describe the text they were rendered from; edits wait until that is the text again.
  const fresh = !!rendered && rendered.source === source;
  const editable = mine && !readOnly && fresh;
  const slides = useMemo(
    () => (rendered ? deckSlides(rendered.source, rendered.deck.slideLines) : []),
    [rendered],
  );
  const reorder = rendered ? canReorder(rendered.source, rendered.deck.slideLines) : false;
  const settings = deckSettings(source);
  const current = rendered ? slideAt(rendered.deck.slideLines, cursorLine) : -1;
  const included = slides.filter((s) => !s.hidden);
  const firstIncluded = included[0]?.index ?? -1;

  const edit = (build: (src: string, lines: readonly number[]) => SourceEdit[]): EditResult => {
    if (!rendered) return false;
    return applyEdit(rendered.source, build(rendered.source, rendered.deck.slideLines));
  };
  // Notes typed a moment ago are written first; the action then waits for the text it leaves behind.
  const flushNotes = useRef<(() => boolean) | null>(null);
  const queued = useRef<((ed: typeof edit) => void) | null>(null);
  useEffect(() => {
    if (fresh && editable && queued.current) {
      const q = queued.current;
      queued.current = null;
      q(edit);
    }
  });
  const act = (run: (ed: typeof edit) => void): void => {
    if (flushNotes.current?.()) queued.current = run;
    else run(edit);
  };
  const move = (i: number, dir: -1 | 1): void =>
    act((ed) => {
      if (ed((src, lines) => moveSlideEdit(src, lines, i, dir)) && open === i) setOpen(i + dir);
    });
  const setHidden = (indices: number[], hidden: boolean): void =>
    act((ed) => void ed((src, lines) => setHiddenEdit(src, lines, indices, hidden)));
  const setKey = (key: string, value: string | boolean | null): void =>
    act((ed) => void ed((src) => frontmatterEdit(src, key, value)));
  const play = (from: number): void => useMarpShow.getState().start(vaultId, path, from);

  const items: MenuItem[] = [
    {
      label: t('drawing.slidePanel.includeAll'),
      onSelect: () =>
        setHidden(
          slides.filter((s) => s.hidden).map((s) => s.index),
          false,
        ),
      disabled: !editable,
    },
    {
      label: t('drawing.slidePanel.excludeAll'),
      onSelect: () =>
        setHidden(
          slides.filter((s) => !s.hidden).map((s) => s.index),
          true,
        ),
      disabled: !editable,
    },
  ];

  const toggle = (p: Exclude<Panel, null>): void => setPanel((v) => (v === p ? null : p));
  const words = slides.reduce((n, s) => n + s.words, 0);

  return (
    <div className="content slides-panel drawing-slides marp-slides-panel">
      <div className="slides-toolbar" role="toolbar" aria-label={t('marp.panel.label')}>
        <button
          type="button"
          className="icon"
          title={t('slides.start')}
          aria-label={t('slides.start')}
          disabled={firstIncluded < 0}
          onClick={() => play(firstIncluded)}
        >
          <Icon name="play" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('drawing.slidePanel.print')}
          aria-label={t('drawing.slidePanel.print')}
          disabled={firstIncluded < 0}
          onClick={() => void exportDeckPdf()}
        >
          <Icon name="print" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('marp.panel.info')}
          aria-label={t('marp.panel.info')}
          aria-pressed={panel === 'info'}
          onClick={() => toggle('info')}
        >
          <Icon name="info" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('drawing.slidePanel.settings')}
          aria-label={t('drawing.slidePanel.settings')}
          aria-pressed={panel === 'settings'}
          onClick={() => toggle('settings')}
        >
          <Icon name="settings" />
        </button>
        <button
          type="button"
          className="icon slides-more"
          aria-label={t('drawing.slidePanel.more')}
          title={t('drawing.slidePanel.more')}
          onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
        >
          …
        </button>
      </div>

      {panel === 'settings' && (
        <fieldset className="slides-options" disabled={!editable}>
          <legend>{t('drawing.slidePanel.settingsTitle')}</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.loop}
              onChange={(e) => setKey(LOOP_KEY, e.target.checked ? true : null)}
            />
            {t('drawing.slidePanel.slideLoop')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.paginate}
              onChange={(e) => setKey('paginate', e.target.checked ? true : null)}
            />
            {t('marp.panel.paginate')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.notes}
              onChange={(e) => setKey(NOTES_KEY, e.target.checked ? null : false)}
            />
            {t('drawing.slidePanel.slideNotes')}
          </label>
          <label>
            {t('marp.panel.theme')}
            <select value={settings.theme} onChange={(e) => setKey('theme', e.target.value)}>
              {(THEMES as readonly string[]).includes(settings.theme) ? null : (
                <option value={settings.theme}>{settings.theme}</option>
              )}
              {THEMES.map((v) => (
                <option key={v} value={v}>
                  {t(`marp.panel.theme_${v}`)}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}

      {panel === 'info' && (
        <dl className="slides-info">
          <dt>{t('marp.panel.infoSlides')}</dt>
          <dd>{slides.length}</dd>
          <dt>{t('marp.panel.infoIncluded')}</dt>
          <dd>{included.length}</dd>
          <dt>{t('marp.panel.theme')}</dt>
          <dd>{settings.theme}</dd>
          <dt>{t('marp.panel.infoWords')}</dt>
          <dd>{words}</dd>
          <dt>{t('marp.panel.infoNotes')}</dt>
          <dd>{slides.filter((s) => s.notes).length}</dd>
        </dl>
      )}

      {slides.length === 0 ? (
        <div className="muted pad">{t('marp.panel.empty')}</div>
      ) : (
        <>
          <div className="slides-summary">
            <span>{t('marp.panel.summary', { n: included.length, total: slides.length })}</span>
          </div>
          <ol className="slide-cards" aria-label={t('slides.list')}>
            {slides.map((s, i) => (
              <li
                key={s.index}
                data-testid="marp-card"
                className={`slide-card${s.hidden ? ' excluded' : ''}${open === i ? ' selected' : ''}${current === i ? ' current' : ''}`}
                aria-current={current === i ? 'true' : undefined}
                onClick={() => {
                  setOpen(i);
                  goToSlide(s.start);
                }}
              >
                <header>
                  <span className="title">
                    {i + 1}. {s.title || t('marp.panel.untitled', { n: i + 1 })}
                  </span>
                  <button
                    type="button"
                    className="icon"
                    aria-label={t('marp.panel.goTo')}
                    title={t('marp.panel.goTo')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(i);
                      goToSlide(s.start);
                    }}
                  >
                    <Icon name="pencil" />
                  </button>
                </header>
                <div className="slide-thumb-box">
                  {rendered?.svgs[i] ? (
                    <Thumb svg={rendered.svgs[i]} css={rendered.deck.css} />
                  ) : (
                    <span className="thumb-wait" />
                  )}
                </div>
                <div className="slide-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="icon"
                    disabled={!editable || !reorder || i === 0}
                    aria-label={t('drawing.slidePanel.up')}
                    title={reorder ? t('drawing.slidePanel.up') : t('marp.panel.noReorder')}
                    onClick={() => move(i, -1)}
                  >
                    <Icon name="arrowUp" />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    disabled={!editable || !reorder || i === slides.length - 1}
                    aria-label={t('drawing.slidePanel.down')}
                    title={reorder ? t('drawing.slidePanel.down') : t('marp.panel.noReorder')}
                    onClick={() => move(i, 1)}
                  >
                    <Icon name="arrowDown" />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    disabled={!editable}
                    aria-pressed={!s.hidden}
                    aria-label={t(
                      s.hidden ? 'drawing.slidePanel.include' : 'drawing.slidePanel.exclude',
                    )}
                    title={t(
                      s.hidden ? 'drawing.slidePanel.include' : 'drawing.slidePanel.exclude',
                    )}
                    onClick={() => setHidden([i], !s.hidden)}
                  >
                    <Icon name={s.hidden ? 'hidden' : 'visible'} />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    disabled={s.hidden}
                    aria-label={t('drawing.slidePanel.playFrom')}
                    title={t('drawing.slidePanel.playFrom')}
                    onClick={() => play(i)}
                  >
                    <Icon name="play" />
                  </button>
                </div>
                {open === i && (
                  <div className="slide-notes-box" onClick={(e) => e.stopPropagation()}>
                    <Notes
                      slide={s}
                      editable={editable}
                      flushRef={flushNotes}
                      save={(index, text) =>
                        edit((src, lines) => notesEdit(src, lines, index, text))
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}
