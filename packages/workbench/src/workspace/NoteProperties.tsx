import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseProperties } from '@memobrain/markdown';
import { api } from '../app/api';
import { dialog } from '../ui/dialogs';
import { Icon } from '../shell/icons';

export type PropKind = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
export const propKinds: readonly PropKind[] = [
  'text',
  'list',
  'number',
  'checkbox',
  'date',
  'datetime',
];

/** The type a value has when the vault declares none (mirrors properties.Infer in Go). */
export function inferKind(v: unknown): PropKind {
  if (typeof v === 'boolean') return 'checkbox';
  if (typeof v === 'number') return 'number';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return 'datetime';
  }
  return 'text';
}

interface Props {
  vaultId: string;
  path: string;
  /** Latest note text (the editor's, including unsaved edits). */
  text: string;
  /** Saves pending edits and returns the hash of what is on disk. */
  prepare: () => Promise<string>;
  /** Called after a property was written so the editor reloads the file. */
  onChanged: () => void;
}

/** Text shown in an input for a property value. */
export function show(value: unknown): string {
  if (Array.isArray(value)) return value.map(show).join(', ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value) ?? '';
}

// Remounted (key) whenever the stored value changes, so the draft never goes stale.
export function ValueEditor({
  kind,
  value,
  onCommit,
}: {
  kind: PropKind;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const [draft, setDraft] = useState(() => show(value));
  if (kind === 'checkbox')
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onCommit(e.target.checked)}
      />
    );
  if (kind === 'list') {
    return (
      <input
        value={draft}
        placeholder="a, b, c"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const list = draft
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (JSON.stringify(list) !== JSON.stringify(value)) onCommit(list);
        }}
      />
    );
  }
  const type =
    kind === 'number'
      ? 'number'
      : kind === 'date'
        ? 'date'
        : kind === 'datetime'
          ? 'datetime-local'
          : 'text';
  return (
    <input
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === show(value)) return;
        onCommit(kind === 'number' ? (draft === '' ? null : Number(draft)) : draft);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Typed editor for the frontmatter of the open note (§2.2.1 "Properties"). */
export function NoteProperties({ vaultId, path, text, prepare, onChanged }: Props) {
  const { t } = useTranslation();
  const [schema, setSchema] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(true);
  // Only the frontmatter block is parsed, not the whole note.
  const props = useMemo(() => parseProperties(text), [text]);
  const entries = Object.entries(props);

  useEffect(() => {
    void api.properties
      .schema(vaultId)
      .then(setSchema)
      .catch(() => undefined);
  }, [vaultId]);

  const run = async (fn: (hash: string) => Promise<unknown>) => {
    try {
      await fn(await prepare());
      onChanged();
    } catch (e) {
      await dialog.error(e);
    }
  };

  const addProperty = async () => {
    const key = await dialog.prompt(t('properties.add'), '', t('properties.name'));
    if (!key?.trim()) return;
    await run((hash) => api.properties.update(vaultId, path, key.trim(), '', hash));
  };

  if (entries.length === 0 && !open) return null;
  return (
    <section className="note-properties" aria-label={t('properties.title')}>
      <header onClick={() => setOpen(!open)}>
        <span className="caret">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        </span>{' '}
        {t('properties.title')} <span className="muted">({entries.length})</span>
      </header>
      {open && (
        <div className="props">
          {entries.map(([key, value]) => {
            const kind = (
              propKinds.includes(schema[key] as PropKind) ? schema[key] : inferKind(value)
            ) as PropKind;
            return (
              <div className="prop" key={key}>
                <span className="key" title={key}>
                  {key}
                </span>
                <select
                  aria-label={t('properties.type', { key })}
                  value={kind}
                  onChange={(e) =>
                    void api.properties
                      .setType(vaultId, key, e.target.value)
                      .then(() => api.properties.schema(vaultId))
                      .then(setSchema)
                      .catch((err) => dialog.error(err))
                  }
                >
                  {propKinds.map((k) => (
                    <option key={k} value={k}>
                      {t(`properties.kind.${k}`)}
                    </option>
                  ))}
                </select>
                <ValueEditor
                  key={`${kind}:${show(value)}`}
                  kind={kind}
                  value={value}
                  onCommit={(v) =>
                    void run((hash) => api.properties.update(vaultId, path, key, v, hash))
                  }
                />
                <button
                  className="icon"
                  title={t('properties.remove')}
                  aria-label={t('properties.remove')}
                  onClick={() =>
                    void run((hash) => api.properties.remove(vaultId, path, key, hash))
                  }
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            );
          })}
          <button className="icon add" onClick={() => void addProperty()}>
            ＋ {t('properties.add')}
          </button>
        </div>
      )}
    </section>
  );
}
