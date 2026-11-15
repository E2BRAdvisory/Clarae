import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type Suggestion } from '../app/api';
import { createNote } from '../app/actions';
import { classify, KIND_ICON } from '../embeds/media';
import { Icon } from '../shell/icons';
import { dialog } from '../ui/dialogs';
import { useAppStore } from '../state/store';

/**
 * The kind of thing a suggestion is, the key of the text that says it (switcher.kind.*): notes,
 * presentations (a .marp is a note for the index), the files of other kinds the core lists
 * (applications, canvases, bases, drawings), aliases and headings.
 */
export function switcherKind(it: Suggestion): string {
  if (it.kind === 'note') return classify(it.path) === 'presentation' ? 'presentation' : 'note';
  return it.kind;
}

/**
 * What a screen reader says of an option: the name, what it is (the icon says it to the eye only)
 * and the folder, or the note an alias stands for. The level of a heading is a row of # signs, not words.
 */
export function optionLabel(it: Suggestion, kind: string): string {
  const where = it.kind === 'heading' ? '' : (it.detail ?? '');
  return [it.label, kind, where].filter((x) => x !== '').join(', ');
}

/** The icon of a suggestion: the one of the kind of its file, as in the file explorer. */
const iconOf = (it: Suggestion) => KIND_ICON[it.path ? classify(it.path) : 'note'];

/**
 * Whether the switcher offers to create a note named like the query: not when a note or an alias
 * already has that name. That includes a presentation (.marp) and its aliases: a link `[[Road]]`
 * resolves to `Road.marp` as to a note, and creating `Road.md` would silently turn every existing
 * link to the new, empty note (in 1.7.0 the creation was refused for the same reason). An
 * application, a canvas, a base, a drawing or a heading with the same name does not count: a link
 * does not resolve to them as to a note, and "Road" the canvas must not take away the way to create
 * the note "Road".
 */
export function canCreateNote(query: string, items: readonly Suggestion[]): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return false;
  return !items.some(
    (i) => (i.kind === 'note' || i.kind === 'alias') && i.label.toLowerCase() === q,
  );
}

/**
 * Ctrl/Cmd+O: open a file of the vault by (fuzzy) name, a note, an application, a canvas, a base or
 * a drawing; Mod-Enter opens it in a new tab; unknown names can be created as notes. A file opens
 * as everywhere else, through openNote, so each kind lands in its own view.
 */
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
    void api.links
      .suggest(vaultId, 'all', query, '', 30)
      .then((r) => {
        if (!stale) setItems(r);
      })
      // a search that fails (the vault closed under it) lists nothing; there is nothing to open then
      .catch(() => {
        if (!stale) setItems([]);
      });
    return () => {
      stale = true;
    };
  }, [vaultId, query]);

  const close = (): void => useAppStore.getState().setSwitcherOpen(false);
  const canCreate = canCreateNote(query, items);
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
          role="combobox"
          aria-expanded="true"
          aria-controls="switcher-results"
          aria-autocomplete="list"
          aria-activedescendant={index < total ? `switcher-opt-${index}` : undefined}
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
        <div
          className="results"
          id="switcher-results"
          role="listbox"
          tabIndex={-1}
          aria-label={t('switcher.title')}
        >
          {items.map((it, i) => (
            <div
              key={`${it.kind}:${it.path}:${it.line}:${it.label}`}
              id={`switcher-opt-${i}`}
              role="option"
              aria-label={optionLabel(it, t(`switcher.kind.${switcherKind(it)}`))}
              aria-selected={i === index}
              className={`result ${i === index ? 'selected' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={(e) => void choose(i, e.metaKey || e.ctrlKey)}
            >
              <span className="name">
                <Icon name={iconOf(it)} size={16} />
                <span className="label">{it.label}</span>
              </span>
              <span className="keys">{it.detail ?? it.path}</span>
            </div>
          ))}
          {canCreate && (
            <div
              id={`switcher-opt-${items.length}`}
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
