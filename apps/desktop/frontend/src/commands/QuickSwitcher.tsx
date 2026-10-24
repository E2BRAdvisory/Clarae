import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Suggestion } from '../app/api';
import { createNote } from '../app/actions';
import { dialog } from '../ui/dialogs';
import { useAppStore } from '../state/store';

/** Ctrl/Cmd+O: open a note by (fuzzy) name; Mod-Enter opens it in a new tab; unknown names can be created. */
export function QuickSwitcher() {
  const open = useAppStore((s) => s.switcherOpen);
  const vault = useAppStore((s) => s.vault);
  return open && vault ? <SwitcherBody vaultId={vault.id} /> : null;
}

function SwitcherBody({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    let stale = false;
    void api.links.suggest(vaultId, 'all', query, '', 30).then((r) => {
      if (!stale) setItems(r);
    });
    return () => {
      stale = true;
    };
  }, [vaultId, query]);

  const close = (): void => useAppStore.getState().setSwitcherOpen(false);
  const canCreate =
    query.trim() !== '' && !items.some((i) => i.label.toLowerCase() === query.trim().toLowerCase());
  const total = items.length + (canCreate ? 1 : 0);

  const choose = async (i: number, newTab: boolean): Promise<void> => {
    close();
    const it = items[i];
    if (it) {
      useAppStore.getState().openNote(it.path, { newTab });
    } else if (canCreate) {
      try {
        await createNote({ name: query.trim(), newTab });
      } catch (e) {
        await dialog.error(e);
      }
    }
  };

  return (
    <div className="modal-backdrop top" onMouseDown={close} role="presentation">
      <div
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('switcher.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={query}
          placeholder={t('switcher.placeholder')}
          aria-label={t('switcher.placeholder')}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(total - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void choose(index, e.metaKey || e.ctrlKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="results" role="listbox">
          {items.map((it, i) => (
            <div
              key={`${it.path}:${it.label}`}
              role="option"
              aria-selected={i === index}
              className={`result ${i === index ? 'selected' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={(e) => void choose(i, e.metaKey || e.ctrlKey)}
            >
              <span>{it.label.replace(/\.md$/, '')}</span>
              <span className="keys">{it.detail ?? it.path}</span>
            </div>
          ))}
          {canCreate && (
            <div
              role="option"
              aria-selected={index === items.length}
              className={`result ${index === items.length ? 'selected' : ''}`}
              onMouseEnter={() => setIndex(items.length)}
              onClick={() => void choose(items.length, false)}
            >
              <span>{t('switcher.create', { name: query.trim() })}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
