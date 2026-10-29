// "Describe the drawing": a keyboard- and screen-reader-friendly text version of the canvas.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Description } from './describe';

export function DescribeDialog({
  description,
  onClose,
}: {
  description: Description;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => modal.current?.focus(), []);
  const empty =
    description.counts.length === 0 &&
    description.texts.length === 0 &&
    description.frames.length === 0;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={modal}
        tabIndex={-1}
        className="modal describe-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('drawing.describe.title')}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2>{t('drawing.describe.title')}</h2>
        {empty && <p className="muted">{t('drawing.describe.empty')}</p>}
        {description.counts.length > 0 && (
          <section aria-label={t('drawing.describe.contents')}>
            <h3>{t('drawing.describe.contents')}</h3>
            <ul>
              {description.counts.map((c) => (
                <li key={c.type}>
                  {t('drawing.describe.count', {
                    type: t(`drawing.describe.types.${c.type}`, { defaultValue: c.type }),
                    count: c.count,
                  })}
                </li>
              ))}
            </ul>
          </section>
        )}
        {description.frames.length > 0 && (
          <section aria-label={t('drawing.describe.frames')}>
            <h3>{t('drawing.describe.frames')}</h3>
            <ol>
              {description.frames.map((f, i) => (
                <li key={`${i}-${f}`}>{f}</li>
              ))}
            </ol>
          </section>
        )}
        {description.texts.length > 0 && (
          <section aria-label={t('drawing.describe.texts')}>
            <h3>{t('drawing.describe.texts')}</h3>
            <ul>
              {description.texts.map((x, i) => (
                <li key={`${i}-${x}`} className="describe-text">
                  {x}
                </li>
              ))}
            </ul>
          </section>
        )}
        {description.links.length > 0 && (
          <section aria-label={t('drawing.describe.links')}>
            <h3>{t('drawing.describe.links')}</h3>
            <ul>
              {description.links.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>{t('drawing.toolsPanel.close')}</button>
        </div>
      </div>
    </div>
  );
}
