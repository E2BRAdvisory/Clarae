import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commands, commandTitle, currentCombos } from '../commands/registry';
import { comboFromEvent, comboIndex, formatCombo } from '../commands/hotkeys';
import { useSettings } from '../state/settings';
import { Icon } from '../shell/icons';

/** Lists every command with its hotkeys; click a hotkey to record a new one. Conflicts are flagged. */
export function HotkeysEditor() {
  const { t } = useTranslation();
  const overrides = useSettings((s) => s.hotkeys);
  const setHotkeys = useSettings((s) => s.setHotkeys);
  const [filter, setFilter] = useState('');
  const [recording, setRecording] = useState<string | null>(null);

  const effective = useMemo(() => currentCombos(overrides), [overrides]);
  const conflicts = useMemo(() => {
    const idx = comboIndex(effective);
    const out = new Set<string>();
    for (const [combo, ids] of idx)
      if (ids.length > 1) ids.forEach((id) => out.add(`${id}|${combo}`));
    return out;
  }, [effective]);

  const set = (id: string, combos: string[]): void => {
    const def = commands.find((c) => c.id === id)?.defaults ?? [];
    const next = { ...overrides };
    if (JSON.stringify(combos) === JSON.stringify(def)) delete next[id];
    else next[id] = combos;
    setHotkeys(next);
  };

  const rows = commands.filter((c) =>
    commandTitle(c.id).toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="hotkeys">
      <input
        type="search"
        value={filter}
        placeholder={t('hotkeys.filter')}
        aria-label={t('hotkeys.filter')}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="hotkey-list">
        {rows.map((c) => {
          const combos = effective.get(c.id) ?? [];
          return (
            <div className="hotkey-row" key={c.id}>
              <span className="title">{commandTitle(c.id)}</span>
              <span className="combos">
                {combos.map((combo) => (
                  <span
                    key={combo}
                    className={`combo ${conflicts.has(`${c.id}|${combo}`) ? 'conflict' : ''}`}
                    title={conflicts.has(`${c.id}|${combo}`) ? t('hotkeys.conflict') : ''}
                  >
                    {formatCombo(combo)}
                    <button
                      className="icon"
                      aria-label={t('hotkeys.remove')}
                      onClick={() =>
                        set(
                          c.id,
                          combos.filter((x) => x !== combo),
                        )
                      }
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </span>
                ))}
                <button
                  className={`record ${recording === c.id ? 'active' : ''}`}
                  onClick={() => setRecording(recording === c.id ? null : c.id)}
                  onBlur={() => setRecording((r) => (r === c.id ? null : r))}
                  onKeyDown={(e) => {
                    if (recording !== c.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === 'Escape') return setRecording(null);
                    const combo = comboFromEvent(e.nativeEvent);
                    if (!combo) return; // a lone modifier
                    set(c.id, [...new Set([...combos, combo])]);
                    setRecording(null);
                  }}
                >
                  {recording === c.id ? t('hotkeys.press') : '＋'}
                </button>
                {overrides[c.id] && (
                  <button
                    className="icon"
                    title={t('hotkeys.reset')}
                    aria-label={t('hotkeys.reset')}
                    onClick={() => {
                      const next = { ...overrides };
                      delete next[c.id];
                      setHotkeys(next);
                    }}
                  >
                    <Icon name="reset" />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
