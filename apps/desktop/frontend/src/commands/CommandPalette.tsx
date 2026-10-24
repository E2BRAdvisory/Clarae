import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { useSettings } from '../state/settings';
import { currentCombos, commands, isEnabled, runCommand, commandTitle } from './registry';
import { formatCombo } from './hotkeys';

/** Case-insensitive subsequence match; lower score is better, -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return 0;
  const at = s.indexOf(q);
  if (at >= 0) return at;
  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      if (last >= 0) gaps += i - last - 1;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? 100 + gaps : -1;
}

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  return open ? <PaletteBody /> : null;
}

function PaletteBody() {
  const { t } = useTranslation();
  const overrides = useSettings((s) => s.hotkeys);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const combos = useMemo(() => currentCombos(overrides), [overrides]);
  const items = useMemo(() => {
    return commands
      .filter((c) => !c.hidden && c.id !== 'palette:open' && isEnabled(c))
      .map((c) => ({ c, title: commandTitle(c.id), score: 0 }))
      .map((x) => ({ ...x, score: fuzzyScore(query, x.title) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title));
  }, [query]);

  const close = (): void => useAppStore.getState().setPaletteOpen(false);
  const run = (id: string): void => {
    close();
    void runCommand(id);
  };

  return (
    <div className="modal-backdrop top" onMouseDown={close} role="presentation">
      <div
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={query}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.placeholder')}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const it = items[index];
              if (it) run(it.c.id);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="results" role="listbox">
          {items.map((it, i) => (
            <div
              key={it.c.id}
              role="option"
              aria-selected={i === index}
              className={`result ${i === index ? 'selected' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(it.c.id)}
            >
              <span>{it.title}</span>
              <span className="keys">
                {(combos.get(it.c.id) ?? []).map((k) => formatCombo(k)).join('  ')}
              </span>
            </div>
          ))}
          {items.length === 0 && <div className="muted pad">{t('palette.none')}</div>}
        </div>
      </div>
    </div>
  );
}
