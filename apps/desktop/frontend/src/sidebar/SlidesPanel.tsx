import { useTranslation } from 'react-i18next';
import { SLIDE_KEYS, SLIDE_THEMES, SLIDE_TRANSITIONS, type SlideConfig } from '@memobrain/markdown';
import { api } from '../app/api';
import { useActiveNote } from '../state/activeNote';
import { selectActivePath, useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { slideTitle } from '../slides/model';
import { startSlideshow } from '../slides/actions';
import { SlideView } from '../slides/SlideView';
import { useSlideshow } from '../slides/store';
import { useDeck, useSlideHtml } from '../slides/useDeck';

type Key = keyof SlideConfig;

/** Right sidebar, "Slides" tab: options of the presentation of the note in focus, and its slides. */
export function SlidesPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const path = useAppStore(selectActivePath);
  const note = useActiveNote((s) => s.note);
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);
  const { deck, isNote } = useDeck(vaultId, path);
  // Typing in the note re-renders only the slides that changed, once it pauses.
  const html = useSlideHtml(vaultId, path ?? '', deck.slides, 300);
  const { config } = deck;

  if (!path || !isNote) return <div className="muted pad">{t('slides.openNote')}</div>;

  const set = async (key: Key, value: string | boolean) => {
    if (!note || note.path !== path) return;
    try {
      const hash = await note.prepare();
      await api.properties.update(vaultId, path, SLIDE_KEYS[key], value, hash);
      note.reload();
    } catch (e) {
      await dialog.error(e);
    }
  };

  const editable = !readOnly && !!note && note.path === path;
  return (
    <div className="content slides-panel">
      <fieldset className="slides-options" disabled={!editable}>
        <label>
          {t('slides.transition')}
          <select
            value={config.transition}
            onChange={(e) => void set('transition', e.target.value)}
          >
            {SLIDE_TRANSITIONS.map((v) => (
              <option key={v} value={v}>
                {t(`slides.transition_${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('slides.theme')}
          <select value={config.theme} onChange={(e) => void set('theme', e.target.value)}>
            {SLIDE_THEMES.map((v) => (
              <option key={v} value={v}>
                {t(`slides.theme_${v}`)}
              </option>
            ))}
          </select>
        </label>
        {(['progress', 'numbers', 'notes'] as const).map((k) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={config[k]}
              onChange={(e) => void set(k, e.target.checked)}
            />
            {t(`slides.option_${k}`)}
          </label>
        ))}
      </fieldset>

      <div className="slides-actions">
        <button
          type="button"
          className="primary"
          disabled={deck.slides.length === 0}
          onClick={() => useSlideshow.getState().start(vaultId, path, 0)}
        >
          {t('slides.start')}
        </button>
        <button
          type="button"
          disabled={deck.slides.length === 0}
          onClick={() => void startSlideshow(true)}
        >
          {t('slides.startHere')}
        </button>
      </div>

      {deck.slides.length === 0 ? (
        <div className="muted pad">{t('slides.hint')}</div>
      ) : (
        <ol className="slide-thumbs" aria-label={t('slides.list')}>
          {deck.slides.map((s, i) => (
            <li key={`${i}:${s.line}`}>
              <button
                type="button"
                className="slide-thumb"
                aria-label={t('slides.thumb', { n: i + 1, title: slideTitle(s) })}
                title={slideTitle(s)}
                onClick={() => useSlideshow.getState().start(vaultId, path, i)}
              >
                <SlideView html={html[i]} theme={config.theme} />
                <span className="n" aria-hidden="true">
                  {i + 1}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
