// Settings > "Drawings": per-vault defaults of the Excalidraw editor (.clarae/drawing.json).
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FONT_FAMILIES } from '../drawing/actions/style';
import {
  useDrawingSettings,
  type DrawingLocation,
  type DrawingSettings,
  type DrawingOpenMode,
} from '../drawing/settings';

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <label htmlFor={htmlFor}>{label}</label>
      <div className="row-controls">{children}</div>
    </div>
  );
}

/** A color picker with a "default" state (empty = Excalidraw's own). */
function ColorChoice({
  id,
  value,
  fallback,
  onChange,
}: {
  id: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <input
        id={id}
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : fallback}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" disabled={!value} onClick={() => onChange('')}>
        {t('drawing.settings.styleDefault')}
      </button>
    </>
  );
}

export function DrawingSection() {
  const { t } = useTranslation();
  const s = useDrawingSettings((st) => st.settings);
  const set = useDrawingSettings((st) => st.set);
  return (
    <>
      <Row label={t('drawing.settings.defaultMode')} htmlFor="drawing-mode">
        <select
          id="drawing-mode"
          value={s.defaultMode}
          onChange={(e) => set({ defaultMode: e.target.value as DrawingOpenMode })}
        >
          {(['edit', 'view', 'zen'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`drawing.settings.mode_${m}`)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('drawing.settings.creationLocation')} htmlFor="drawing-location">
        <select
          id="drawing-location"
          value={s.creationLocation}
          onChange={(e) => set({ creationLocation: e.target.value as DrawingLocation })}
        >
          {(['current', 'folder', 'attachments'] as const).map((l) => (
            <option key={l} value={l}>
              {t(`drawing.settings.location_${l}`)}
            </option>
          ))}
        </select>
      </Row>
      {s.creationLocation === 'folder' && (
        <Row label={t('drawing.settings.creationFolder')} htmlFor="drawing-folder">
          <input
            id="drawing-folder"
            value={s.creationFolder}
            onChange={(e) => set({ creationFolder: e.target.value })}
          />
        </Row>
      )}
      <Row label={t('drawing.settings.nameFormat')} htmlFor="drawing-name">
        <input
          id="drawing-name"
          value={s.nameFormat}
          onChange={(e) => set({ nameFormat: e.target.value })}
        />
        <span className="muted small">{t('drawing.settings.nameFormatHelp')}</span>
      </Row>
      <Row label={t('drawing.settings.embedWidth')} htmlFor="drawing-embed">
        <input
          id="drawing-embed"
          type="number"
          min={0}
          max={4000}
          value={s.embedWidth}
          onChange={(e) => set({ embedWidth: Number(e.target.value) })}
        />
      </Row>
      <Row label={t('drawing.settings.exportScale')} htmlFor="drawing-exp-scale">
        <select
          id="drawing-exp-scale"
          value={s.exportScale}
          onChange={(e) => set({ exportScale: Number(e.target.value) })}
        >
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n}x
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('drawing.settings.exportPadding')} htmlFor="drawing-exp-padding">
        <input
          id="drawing-exp-padding"
          type="number"
          min={0}
          max={200}
          value={s.exportPadding}
          onChange={(e) => set({ exportPadding: Number(e.target.value) })}
        />
      </Row>
      <Row label={t('drawing.settings.exportEmbedScene')} htmlFor="drawing-exp-embed">
        <input
          id="drawing-exp-embed"
          type="checkbox"
          checked={s.exportEmbedScene}
          onChange={(e) => set({ exportEmbedScene: e.target.checked })}
        />
      </Row>
      <Row label={t('drawing.settings.autoExport')} htmlFor="drawing-auto">
        <select
          id="drawing-auto"
          value={s.autoExport}
          onChange={(e) => set({ autoExport: e.target.value as DrawingSettings['autoExport'] })}
        >
          {(['none', 'png', 'svg', 'both'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`drawing.settings.auto_${m}`)}
            </option>
          ))}
        </select>
      </Row>
      {s.autoExport !== 'none' && (
        <Row label={t('drawing.settings.autoExportTheme')} htmlFor="drawing-auto-theme">
          <select
            id="drawing-auto-theme"
            value={s.autoExportTheme}
            onChange={(e) =>
              set({ autoExportTheme: e.target.value as DrawingSettings['autoExportTheme'] })
            }
          >
            {(['light', 'dark', 'both'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`drawing.settings.theme_${m}`)}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row label={t('drawing.settings.defaultStroke')} htmlFor="drawing-def-stroke">
        <ColorChoice
          id="drawing-def-stroke"
          value={s.defaultStroke}
          fallback="#1e1e1e"
          onChange={(v) => set({ defaultStroke: v })}
        />
      </Row>
      <Row label={t('drawing.settings.defaultFill')} htmlFor="drawing-def-fill">
        <ColorChoice
          id="drawing-def-fill"
          value={s.defaultFill}
          fallback="#ffffff"
          onChange={(v) => set({ defaultFill: v })}
        />
      </Row>
      <Row label={t('drawing.settings.defaultFont')} htmlFor="drawing-def-font">
        <select
          id="drawing-def-font"
          value={s.defaultFont}
          onChange={(e) => set({ defaultFont: Number(e.target.value) })}
        >
          <option value={0}>{t('drawing.settings.styleDefault')}</option>
          {FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('drawing.settings.defaultFontSize')} htmlFor="drawing-def-fsize">
        <input
          id="drawing-def-fsize"
          type="number"
          min={0}
          max={120}
          value={s.defaultFontSize}
          onChange={(e) => set({ defaultFontSize: Number(e.target.value) })}
        />
        <span className="muted small">{t('drawing.settings.zeroIsDefault')}</span>
      </Row>
    </>
  );
}
