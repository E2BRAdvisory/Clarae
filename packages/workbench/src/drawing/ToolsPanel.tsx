// The tools panel: every action and tool of the drawing editor in one searchable list, grouped like
// the script library, with the user's favorites on top and the recently used ones after them.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commands, commandTitle, isEnabled, runCommand } from '../commands/registry';
import { useAppStore } from '../state/store';
import { SCENE_ACTIONS } from './actions/registry';
import { useDrawingSettings } from './settings';
import { featureOfCommand, toolIds } from './sceneCommands';
import { drawingFeatureOn } from '../state/managed';
import { Icon } from '../shell/icons';

const RECENT_MAX = 6;
const recentKey = (vaultId: string): string => `clarae.drawing.tools.recent.${vaultId}`;
/** The key of 1.x: read while the current one has no value yet, never written (dropped in 3.0). */
const legacyRecentKey = (vaultId: string): string => `memobrain.drawing.tools.recent.${vaultId}`;

export function loadRecent(vaultId: string): string[] {
  try {
    const stored =
      localStorage.getItem(recentKey(vaultId)) ?? localStorage.getItem(legacyRecentKey(vaultId));
    const raw = JSON.parse(stored ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveRecent(vaultId: string, id: string, current: string[]): void {
  try {
    const next = [id, ...current.filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(recentKey(vaultId), JSON.stringify(next));
  } catch {
    /* storage unavailable: recents are a convenience */
  }
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

interface Entry {
  id: string;
  group: string;
  title: string;
}

/** The title without its "Drawing: " / "Disegno: " prefix, which every entry would repeat. */
const shortTitle = (id: string): string => commandTitle(id).replace(/^[^:]+:\s*/, '');

function allEntries(): Entry[] {
  const group = new Map<string, string>(SCENE_ACTIONS.map((a) => [`drawing:${a.id}`, a.group]));
  return commands
    .filter((c) => toolIds.has(c.id) && drawingFeatureOn(featureOfCommand(c.id)))
    .map((c) => ({
      id: c.id,
      group: group.get(c.id) ?? (c.id.startsWith('drawing:insert-') ? 'insert' : 'tools'),
      title: shortTitle(c.id),
    }));
}

export function ToolsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const vaultId = useAppStore((s) => s.vault?.id ?? '');
  const favorites = useDrawingSettings((s) => s.settings.toolFavorites);
  const setSettings = useDrawingSettings((s) => s.set);
  const [query, setQuery] = useState('');
  const [recent] = useState(() => loadRecent(vaultId));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const entries = useMemo(() => allEntries(), []);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const q = fold(query.trim());
  const shown = entries.filter((e) => !q || fold(e.title).includes(q));

  const sections: { key: string; title: string; items: Entry[] }[] = [];
  if (!q) {
    const fav = favorites.map((id) => byId.get(`drawing:${id}`)).filter((e): e is Entry => !!e);
    if (fav.length)
      sections.push({ key: 'fav', title: t('drawing.toolsPanel.favorites'), items: fav });
    const rec = recent.map((id) => byId.get(id)).filter((e): e is Entry => !!e);
    if (rec.length)
      sections.push({ key: 'rec', title: t('drawing.toolsPanel.recent'), items: rec });
  }
  const groups = [...new Set(shown.map((e) => e.group))];
  for (const g of groups)
    sections.push({
      key: g,
      title: t(`drawing.toolGroups.${g}`),
      items: shown.filter((e) => e.group === g),
    });

  const run = (id: string) => {
    saveRecent(vaultId, id, recent);
    onClose();
    void runCommand(id);
  };
  const toggleFavorite = (id: string) => {
    const short = id.replace(/^drawing:/, '');
    setSettings({
      toolFavorites: favorites.includes(short)
        ? favorites.filter((f) => f !== short)
        : [...favorites, short],
    });
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal tools-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('drawing.toolsPanel.title')}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2>{t('drawing.toolsPanel.title')}</h2>
        <input
          ref={input}
          type="search"
          value={query}
          placeholder={t('drawing.toolsPanel.search')}
          aria-label={t('drawing.toolsPanel.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="tools-list">
          {sections.length === 0 && <p className="muted">{t('drawing.toolsPanel.none')}</p>}
          {sections.map((s) => (
            <section key={s.key} aria-label={s.title}>
              <h3>{s.title}</h3>
              <ul>
                {s.items.map((e) => {
                  const cmd = commands.find((c) => c.id === e.id);
                  const on = !!cmd && isEnabled(cmd);
                  const starred = favorites.includes(e.id.replace(/^drawing:/, ''));
                  return (
                    <li key={e.id}>
                      <button className="tool-run" disabled={!on} onClick={() => run(e.id)}>
                        {e.title}
                      </button>
                      <button
                        className={`tool-star${starred ? ' active' : ''}`}
                        aria-pressed={starred}
                        aria-label={t(
                          starred ? 'drawing.toolsPanel.unstar' : 'drawing.toolsPanel.star',
                          { name: e.title },
                        )}
                        onClick={() => toggleFavorite(e.id)}
                      >
                        <Icon name={starred ? 'star' : 'starOff'} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{t('drawing.toolsPanel.close')}</button>
        </div>
      </div>
    </div>
  );
}
