// Right sidebar, "Slideshow" tab for a drawing: the Excalidraw plugin's slideshow panel. Every
// frame is a slide; the panel starts, prints and describes the presentation, sets its options,
// reorders slides, leaves them out, renames them and keeps their presenter notes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSceneController } from '../drawing/actions/active';
import { reorderUpdate, slideMetaUpdate, type Slide } from '../drawing/slides';
import { useDrawingSlides } from '../drawing/slidesStore';
import { Icon } from '../shell/icons';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { dialog } from '../ui/dialogs';

/** Fixed width of the slide thumbnails (px). */
const THUMB_WIDTH = 120;

const thumbs = new Map<string, string>();

/** The thumbnail of a frame, drawn again only when the frame changes. */
function Thumb({ path, slide, width }: { path: string; slide: Slide; width: number }) {
  const key = `${path}:${slide.id}:${slide.version}:${width > 200 ? 'l' : 's'}`;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (thumbs.has(key)) return;
    let live = true;
    const timer = setTimeout(() => {
      void getSceneController()
        ?.slideThumbnail(slide.id, width > 200 ? 480 : 240)
        .then((url) => {
          thumbs.set(key, url);
          if (live) setTick((n) => n + 1);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, slide.id, width]);
  const src = thumbs.get(key) ?? '';
  return src ? <img src={src} alt="" draggable={false} /> : <span className="thumb-wait" />;
}

/** Presenter notes of one slide: Markdown text saved on its own 600 ms after typing stops. */
function Notes({ slide, editable }: { slide: Slide; editable: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState(slide.notes);
  const saved = useRef(slide.notes);
  useEffect(() => {
    // Changed elsewhere (undo, sync): follow it unless the user is typing.
    if (slide.notes !== saved.current) {
      saved.current = slide.notes;
      setText(slide.notes);
    }
  }, [slide.notes]);
  useEffect(() => {
    if (text === saved.current) return;
    const timer = setTimeout(() => {
      const c = getSceneController();
      const frame = c?.context().elements.find((e) => e.id === slide.id);
      if (!c || !frame || !c.canEdit()) return;
      saved.current = text.trim();
      c.apply({ update: { [slide.id]: slideMetaUpdate(frame, { notes: text.trim() }) } });
    }, 600);
    return () => clearTimeout(timer);
  }, [text, slide.id]);
  return (
    <>
      <label className="slide-notes-label" htmlFor={`notes-${slide.id}`}>
        {t('drawing.slidePanel.notes')}
      </label>
      <textarea
        id={`notes-${slide.id}`}
        value={text}
        readOnly={!editable}
        placeholder={t('drawing.slidePanel.notesPlaceholder')}
        onChange={(e) => setText(e.target.value)}
      />
      <small className="muted">{t('drawing.slidePanel.notesHint')}</small>
    </>
  );
}

const SETTINGS = [
  { key: 'slideLoop', on: (v: unknown) => v === 'true', whenOn: 'true' as string | null },
  { key: 'slideNumbers', on: (v: unknown) => v !== 'false', whenOn: null as string | null },
  { key: 'slideNotes', on: (v: unknown) => v !== 'false', whenOn: null as string | null },
] as const;

export function DrawingSlidesPanel({ path }: { path: string }) {
  const { t } = useTranslation();
  const store = useDrawingSlides();
  const slides = useMemo(() => (store.path === path ? store.slides : []), [store, path]);
  const controller = getSceneController();
  const editable = !!controller?.canEdit();
  const [showSettings, setShowSettings] = useState(false);
  const [, setRev] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // The drawing's own settings; setRev re-renders after each change made here.
  const settings = getSceneController()?.fileSettings() ?? {};

  const included = slides.filter((s) => s.included).length;
  const withController = (fn: (c: NonNullable<typeof controller>) => void) => {
    const c = getSceneController();
    if (c) fn(c);
  };
  const move = (i: number, step: number) =>
    withController((c) => {
      const order = slides.map((s) => s.id);
      const to = i + step;
      if (to < 0 || to >= order.length) return;
      [order[i], order[to]] = [order[to] as string, order[i] as string];
      c.apply({ update: reorderUpdate(c.context().elements, order) });
    });
  const setIncluded = (ids: string[], on: boolean) =>
    withController((c) => {
      const update: Record<string, Record<string, unknown>> = {};
      for (const id of ids) {
        const f = c.context().elements.find((e) => e.id === id);
        if (f) update[id] = slideMetaUpdate(f, { slideHidden: on ? undefined : true });
      }
      c.apply({ update });
    });
  const rename = async (s: Slide) => {
    const name = await dialog.prompt(t('drawing.slidePanel.rename'), s.name);
    if (!name?.trim()) return;
    withController((c) => c.apply({ update: { [s.id]: { name: name.trim() } } }));
  };
  const resetOrder = () =>
    withController((c) => {
      const update: Record<string, Record<string, unknown>> = {};
      for (const s of slides) {
        const f = c.context().elements.find((e) => e.id === s.id);
        if (f) update[s.id] = slideMetaUpdate(f, { slide: undefined });
      }
      c.apply({ update });
    });
  const setOption = (key: string, whenOn: string | null, on: boolean) => {
    // Options default to the value that is stored as "absent": only the other one is written.
    const stored = on ? whenOn : whenOn === null ? 'false' : null;
    getSceneController()?.setFileSetting(key, stored);
    setRev((n) => n + 1);
  };

  const items: MenuItem[] = [
    {
      label: t('drawing.slidePanel.includeAll'),
      onSelect: () =>
        setIncluded(
          slides.map((s) => s.id),
          true,
        ),
      disabled: !editable,
    },
    {
      label: t('drawing.slidePanel.excludeAll'),
      onSelect: () =>
        setIncluded(
          slides.map((s) => s.id),
          false,
        ),
      disabled: !editable,
    },
    {
      label: t('drawing.slidePanel.resetOrder'),
      onSelect: resetOrder,
      disabled: !editable,
      separator: true,
    },
  ];

  return (
    <div className="content slides-panel drawing-slides">
      <div className="slides-toolbar" role="toolbar" aria-label={t('drawing.slidePanel.label')}>
        <button
          type="button"
          className="icon"
          title={t('slides.start')}
          aria-label={t('slides.start')}
          disabled={included === 0}
          onClick={() => controller?.startSlideshow()}
        >
          <Icon name="play" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('drawing.slidePanel.print')}
          aria-label={t('drawing.slidePanel.print')}
          disabled={included === 0}
          onClick={() => void controller?.printSlides()}
        >
          <Icon name="print" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('drawing.slidePanel.describe')}
          aria-label={t('drawing.slidePanel.describe')}
          onClick={() => controller?.openTool('describe')}
        >
          <Icon name="info" />
        </button>
        <button
          type="button"
          className="icon"
          title={t('drawing.slidePanel.settings')}
          aria-label={t('drawing.slidePanel.settings')}
          aria-pressed={showSettings}
          onClick={() => setShowSettings((v) => !v)}
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

      {showSettings && (
        <fieldset className="slides-options">
          <legend>{t('drawing.slidePanel.settingsTitle')}</legend>
          {SETTINGS.map((o) => (
            <label key={o.key} className="check">
              <input
                type="checkbox"
                checked={o.on(settings[o.key])}
                onChange={(e) => setOption(o.key, o.whenOn, e.target.checked)}
              />
              {t(`drawing.slidePanel.${o.key}`)}
            </label>
          ))}
        </fieldset>
      )}

      {slides.length === 0 ? (
        <div className="muted pad">{t('drawing.slidePanel.empty')}</div>
      ) : (
        <>
          <div className="slides-summary">
            <span>{t('drawing.slidePanel.summary', { n: included, total: slides.length })}</span>
          </div>
          <ol className="slide-cards" aria-label={t('slides.list')}>
            {slides.map((s, i) => (
              <li
                key={s.id}
                className={`slide-card${s.included ? '' : ' excluded'}${open === s.id ? ' selected' : ''}`}
                onClick={() => {
                  setOpen(s.id);
                  controller?.showFrame(s.id);
                }}
              >
                <header>
                  <span className="title">
                    {i + 1}. {s.name}
                  </span>
                  <button
                    type="button"
                    className="icon"
                    disabled={!editable}
                    aria-label={t('drawing.slidePanel.rename')}
                    title={t('drawing.slidePanel.rename')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void rename(s);
                    }}
                  >
                    <Icon name="pencil" />
                  </button>
                </header>
                <div className="slide-thumb-box" style={{ width: THUMB_WIDTH }}>
                  <Thumb path={path} slide={s} width={THUMB_WIDTH} />
                </div>
                <div className="slide-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="icon"
                    disabled={!editable || i === 0}
                    aria-label={t('drawing.slidePanel.up')}
                    title={t('drawing.slidePanel.up')}
                    onClick={() => move(i, -1)}
                  >
                    <Icon name="arrowUp" />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    disabled={!editable || i === slides.length - 1}
                    aria-label={t('drawing.slidePanel.down')}
                    title={t('drawing.slidePanel.down')}
                    onClick={() => move(i, 1)}
                  >
                    <Icon name="arrowDown" />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    disabled={!editable}
                    aria-pressed={s.included}
                    aria-label={t(
                      s.included ? 'drawing.slidePanel.exclude' : 'drawing.slidePanel.include',
                    )}
                    title={t(
                      s.included ? 'drawing.slidePanel.exclude' : 'drawing.slidePanel.include',
                    )}
                    onClick={() => setIncluded([s.id], !s.included)}
                  >
                    <Icon name={s.included ? 'visible' : 'hidden'} />
                  </button>
                  <button
                    type="button"
                    className="icon"
                    disabled={!s.included}
                    aria-label={t('drawing.slidePanel.playFrom')}
                    title={t('drawing.slidePanel.playFrom')}
                    onClick={() => controller?.startSlideshow(s.id)}
                  >
                    <Icon name="play" />
                  </button>
                </div>
                {open === s.id && (
                  <div className="slide-notes-box" onClick={(e) => e.stopPropagation()}>
                    <Notes slide={s} editable={editable} />
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
