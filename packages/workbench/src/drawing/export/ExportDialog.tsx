// The export dialog of the drawing editor: format, scale, theme, padding, embedded scene and what
// to export (everything, the selection or one frame). The result is copied, saved next to the
// drawing in the vault, or saved anywhere through the native "save as" dialog.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportOptions, ExportScope } from './options';

export type ExportAction = 'copy' | 'vault' | 'saveAs' | 'print';

interface Props {
  initial: ExportOptions;
  selectionCount: number;
  frames: { id: string; name: string }[];
  onClose: () => void;
  onExport: (o: ExportOptions, action: ExportAction) => void;
}

export function ExportDialog({ initial, selectionCount, frames, onClose, onExport }: Props) {
  const modal = useRef<HTMLDivElement>(null);
  // Focus moves into the dialog (so Escape and Tab work from the first key press).
  useEffect(() => modal.current?.focus(), []);
  const { t } = useTranslation();
  const [o, setO] = useState<ExportOptions>(initial);
  const patch = (p: Partial<ExportOptions>) => setO((cur) => ({ ...cur, ...p }));
  const scopeValue =
    o.scope.kind === 'frame'
      ? `frame:${o.scope.id}`
      : o.scope.kind === 'selection'
        ? 'selection'
        : 'all';
  const setScope = (v: string) => {
    const scope: ExportScope = v.startsWith('frame:')
      ? { kind: 'frame', id: v.slice('frame:'.length) }
      : v === 'selection'
        ? { kind: 'selection' }
        : { kind: 'all' };
    patch({ scope });
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={modal}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('drawing.export')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2>{t('drawing.export')}</h2>
        <div className="row">
          <label htmlFor="export-scope">{t('drawing.exportScope')}</label>
          <select id="export-scope" value={scopeValue} onChange={(e) => setScope(e.target.value)}>
            <option value="all">{t('drawing.scopeAll')}</option>
            <option value="selection" disabled={selectionCount === 0}>
              {t('drawing.scopeSelection', { n: selectionCount })}
            </option>
            {frames.map((f) => (
              <option key={f.id} value={`frame:${f.id}`}>
                {t('drawing.scopeFrame', { name: f.name })}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          {(['png', 'svg'] as const).map((f) => (
            <label key={f}>
              <input
                type="radio"
                name="fmt"
                checked={o.format === f}
                onChange={() => patch({ format: f })}
              />{' '}
              {f.toUpperCase()}
            </label>
          ))}
        </div>
        {o.format === 'png' && (
          <div className="row">
            <label htmlFor="export-scale">{t('drawing.scale')}</label>
            <select
              id="export-scale"
              value={o.scale}
              onChange={(e) => patch({ scale: Number(e.target.value) })}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}x
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="row">
          <label htmlFor="export-padding">{t('drawing.padding')}</label>
          <input
            id="export-padding"
            type="number"
            min={0}
            max={200}
            value={o.padding}
            onChange={(e) =>
              patch({ padding: Math.min(200, Math.max(0, Number(e.target.value) || 0)) })
            }
          />
        </div>
        <label>
          <input
            type="checkbox"
            checked={o.background}
            onChange={(e) => patch({ background: e.target.checked })}
          />{' '}
          {t('drawing.background')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={o.dark}
            onChange={(e) => patch({ dark: e.target.checked })}
          />{' '}
          {t('drawing.darkTheme')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={o.embedScene}
            onChange={(e) => patch({ embedScene: e.target.checked })}
          />{' '}
          {t('drawing.embedScene')}
        </label>
        <div className="actions">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button onClick={() => onExport(o, 'copy')}>{t('drawing.copy')}</button>
          <button onClick={() => onExport(o, 'saveAs')}>{t('drawing.saveAs')}</button>
          <button onClick={() => onExport(o, 'print')}>{t('drawing.printPdf')}</button>
          <button className="primary" onClick={() => onExport(o, 'vault')}>
            {t('drawing.saveToVault')}
          </button>
        </div>
      </div>
    </div>
  );
}
