// Settings > "Daily notes & templates": daily notes, unique notes, templates, slash commands and
// the composer. Keys an administrator manages (`daily_notes.*`) are disabled and marked.
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type TemplateInfo } from '../app/api';
import { templateLabel } from '../daily/actions';
import {
  notesCfgKey,
  useNotesSettings,
  type MergeSeparator,
  type NotesSettings,
} from '../daily/settings';
import { isLocked, useManaged } from '../state/managed';
import { useAppStore } from '../state/store';
import { Icon } from '../shell/icons';

function Row({
  label,
  htmlFor,
  field,
  children,
}: {
  label: string;
  htmlFor: string;
  field?: keyof NotesSettings;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const key = field ? notesCfgKey(field) : undefined;
  const locked = useManaged((m) => (key ? isLocked(m.locked, key) : false));
  return (
    <div className={`row${locked ? ' managed' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      <fieldset className="row-controls" disabled={locked}>
        {children}
      </fieldset>
      {locked && (
        <span className="muted small managed-note">
          <Icon name="lock" size={14} /> {t('settings.managedByAdmin')}
        </span>
      )}
    </div>
  );
}

function Text({ id, label, k }: { id: string; label: string; k: keyof NotesSettings }) {
  const value = useNotesSettings((s) => s.settings[k]) as string;
  const set = useNotesSettings((s) => s.set);
  return (
    <Row label={label} htmlFor={id} field={k}>
      <input id={id} value={value} onChange={(e) => set({ [k]: e.target.value })} />
    </Row>
  );
}

function Check({ id, label, k }: { id: string; label: string; k: keyof NotesSettings }) {
  const value = useNotesSettings((s) => s.settings[k]) as boolean;
  const set = useNotesSettings((s) => s.set);
  return (
    <Row label={label} htmlFor={id} field={k}>
      <input
        id={id}
        type="checkbox"
        checked={value}
        onChange={(e) => set({ [k]: e.target.checked })}
      />
    </Row>
  );
}

function TemplateSelect({
  id,
  label,
  k,
  options,
  folder,
}: {
  id: string;
  label: string;
  k: 'dailyTemplate' | 'uniqueTemplate' | 'newNoteTemplate';
  options: TemplateInfo[];
  folder: string;
}) {
  const { t } = useTranslation();
  const value = useNotesSettings((s) => s.settings[k]);
  const set = useNotesSettings((s) => s.set);
  const known = value === '' || options.some((o) => o.ref === value);
  return (
    <Row label={label} htmlFor={id} field={k}>
      <select id={id} value={value} onChange={(e) => set({ [k]: e.target.value })}>
        <option value="">{t('settings.daily.noTemplate')}</option>
        {!known && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.ref} value={o.ref}>
            {templateLabel(o, folder)}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function DailySection() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const folder = useNotesSettings((s) => s.settings.templatesFolder);
  const separator = useNotesSettings((s) => s.settings.mergeSeparator);
  const set = useNotesSettings((s) => s.set);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);

  useEffect(() => {
    if (!vault) return;
    let stale = false;
    void api.templates
      .list(vault.id, folder)
      .then((l) => !stale && setTemplates(l))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [vault, folder]);

  if (!vault) return <p className="muted">{t('settings.needsVault')}</p>;
  return (
    <>
      <h4>{t('settings.daily.templates')}</h4>
      <Text id="tpl-folder" label={t('settings.daily.templatesFolder')} k="templatesFolder" />
      <p className="muted small">
        <code>{'{{date}} {{date:FORMAT}} {{time}} {{time:FORMAT}} {{title}}'}</code>{' '}
        {t('settings.daily.variablesHelp')}
      </p>
      <TemplateSelect
        id="new-note-template"
        label={t('settings.daily.newNoteTemplate')}
        k="newNoteTemplate"
        options={templates}
        folder={folder}
      />

      <h4>{t('settings.daily.daily')}</h4>
      <Text id="daily-folder" label={t('settings.daily.folder')} k="dailyFolder" />
      <Text id="daily-format" label={t('settings.daily.format')} k="dailyFormat" />
      <TemplateSelect
        id="daily-template"
        label={t('settings.daily.template')}
        k="dailyTemplate"
        options={templates}
        folder={folder}
      />

      <h4>{t('settings.daily.unique')}</h4>
      <Text id="unique-folder" label={t('settings.daily.folder')} k="uniqueFolder" />
      <Text id="unique-format" label={t('settings.daily.format')} k="uniqueFormat" />
      <TemplateSelect
        id="unique-template"
        label={t('settings.daily.template')}
        k="uniqueTemplate"
        options={templates}
        folder={folder}
      />

      <h4>{t('settings.daily.composer')}</h4>
      <Row label={t('settings.daily.mergeSeparator')} htmlFor="merge-sep">
        <select
          id="merge-sep"
          value={separator}
          onChange={(e) => set({ mergeSeparator: e.target.value as MergeSeparator })}
        >
          <option value="heading">{t('settings.daily.sepHeading')}</option>
          <option value="rule">{t('settings.daily.sepRule')}</option>
          <option value="none">{t('settings.daily.sepNone')}</option>
        </select>
      </Row>
      <Check id="extract-embed" label={t('settings.daily.extractEmbed')} k="extractEmbed" />
      <Check
        id="extract-fm"
        label={t('settings.daily.extractFrontmatter')}
        k="extractFrontmatter"
      />

      <h4>{t('settings.daily.editor')}</h4>
      <Check id="slash" label={t('settings.daily.slash')} k="slashCommands" />
    </>
  );
}
