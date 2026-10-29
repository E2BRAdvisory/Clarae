// Filter, group, display and force controls of the graph view. Native inputs only, so every
// control is reachable and operable from the keyboard.
import { useTranslation } from 'react-i18next';
import { GROUP_COLORS, type GraphSettings } from './settings';
import { forceRanges, type Forces } from './types';
import { Icon } from '../shell/icons';

const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="graph-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

interface Props {
  settings: GraphSettings;
  local: boolean;
  update: (patch: Partial<GraphSettings>) => void;
}

export function GraphPanel({ settings: s, local, update }: Props) {
  const { t } = useTranslation();
  const toggle = (key: 'showOrphans' | 'showGhosts' | 'showAttachments' | 'showTags') => (
    <label className="graph-row check">
      <input
        type="checkbox"
        checked={s[key]}
        onChange={(e) => update({ [key]: e.target.checked })}
      />
      <span>{t(`graph.${key}`)}</span>
    </label>
  );
  const force = (k: keyof Forces) => (
    <Range
      key={k}
      label={t(`graph.${k}`)}
      value={s.forces[k]}
      {...forceRanges[k]}
      onChange={(v) => update({ forces: { ...s.forces, [k]: v } })}
    />
  );
  return (
    <div className="graph-panel" role="region" aria-label={t('graph.settings')}>
      <details open>
        <summary>{t('graph.filters')}</summary>
        <label className="graph-row stack">
          <span>{t('graph.query')}</span>
          <input
            type="search"
            value={s.query}
            placeholder={t('graph.queryPlaceholder')}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
        <label className="graph-row stack">
          <span>{t('graph.tags')}</span>
          <input
            type="text"
            defaultValue={s.tags.join(', ')}
            onBlur={(e) => update({ tags: list(e.target.value) })}
            onKeyDown={(e) => e.key === 'Enter' && update({ tags: list(e.currentTarget.value) })}
          />
        </label>
        <label className="graph-row stack">
          <span>{t('graph.folders')}</span>
          <input
            type="text"
            defaultValue={s.folders.join(', ')}
            onBlur={(e) => update({ folders: list(e.target.value) })}
            onKeyDown={(e) => e.key === 'Enter' && update({ folders: list(e.currentTarget.value) })}
          />
        </label>
        {toggle('showOrphans')}
        {toggle('showGhosts')}
        {toggle('showAttachments')}
        {toggle('showTags')}
      </details>
      {local && (
        <details open>
          <summary>{t('graph.local')}</summary>
          <Range
            label={t('graph.depth')}
            value={s.localDepth}
            min={1}
            max={5}
            step={1}
            onChange={(v) => update({ localDepth: v })}
          />
          <label className="graph-row stack">
            <span>{t('graph.direction')}</span>
            <select
              value={s.localDirection}
              onChange={(e) =>
                update({ localDirection: e.target.value as GraphSettings['localDirection'] })
              }
            >
              {(['both', 'in', 'out'] as const).map((d) => (
                <option key={d} value={d}>
                  {t(`graph.${d}`)}
                </option>
              ))}
            </select>
          </label>
        </details>
      )}
      <details>
        <summary>{t('graph.groups')}</summary>
        {s.groups.map((g, i) => (
          <div className="graph-group" key={i}>
            <input
              type="color"
              value={g.color}
              aria-label={t('graph.groupColor')}
              onChange={(e) =>
                update({
                  groups: s.groups.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)),
                })
              }
            />
            <input
              type="text"
              value={g.query}
              aria-label={t('graph.groupQuery')}
              placeholder={t('graph.queryPlaceholder')}
              onChange={(e) =>
                update({
                  groups: s.groups.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)),
                })
              }
            />
            <button
              type="button"
              className="icon"
              aria-label={t('graph.removeGroup')}
              onClick={() => update({ groups: s.groups.filter((_, j) => j !== i) })}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            update({
              groups: [
                ...s.groups,
                { query: '', color: GROUP_COLORS[s.groups.length % GROUP_COLORS.length] as string },
              ],
            })
          }
        >
          {t('graph.addGroup')}
        </button>
      </details>
      <details>
        <summary>{t('graph.display')}</summary>
        <Range
          label={t('graph.nodeSize')}
          value={s.nodeSize}
          min={0.5}
          max={3}
          step={0.1}
          onChange={(v) => update({ nodeSize: v })}
        />
        <Range
          label={t('graph.labelZoom')}
          value={s.labelZoom}
          min={0.2}
          max={4}
          step={0.1}
          onChange={(v) => update({ labelZoom: v })}
        />
        <Range
          label={t('graph.timelapseSeconds')}
          value={s.timelapseSeconds}
          min={2}
          max={120}
          step={1}
          onChange={(v) => update({ timelapseSeconds: v })}
        />
      </details>
      <details>
        <summary>{t('graph.forces')}</summary>
        {(['center', 'repel', 'linkStrength', 'linkDistance'] as const).map(force)}
      </details>
    </div>
  );
}
