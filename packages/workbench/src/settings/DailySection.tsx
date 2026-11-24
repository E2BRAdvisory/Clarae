// Settings > "Daily notes & templates": daily notes, unique notes, templates, slash commands and
// the composer. Keys an administrator manages (`daily_notes.*`) are disabled and marked.
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type TemplateInfo, type TemplateKind } from '../app/api';
import { deleteEntry } from '../app/actions';
import { newTemplate, templateLabel } from '../daily/actions';
import { Feature } from '@clarae/api-client/features';
import { featureOn } from '../state/managed';
import { dialog } from '../ui/dialogs';
import {
  notesCfgKey,
  useNotesSettings,
  type MergeSeparator,
  type NotesSettings,
} from '../daily/settings';
import { isLocked, useManaged } from '../state/managed';
import { infoOf, useSync } from '../state/sync';
import { useAppStore } from '../state/store';
import { Icon } from '../shell/icons';
import { CONFIG_DIR } from '../platform/vaultPaths';

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
}: {
  id: string;
  label: string;
  k:
    | 'dailyTemplate'
    | 'uniqueTemplate'
    | 'newNoteTemplate'
    | 'newDrawingTemplate'
    | 'newPresentationTemplate';
  options: TemplateInfo[];
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
            {templateLabel(o)}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function DailySection() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const separator = useNotesSettings((s) => s.settings.mergeSeparator);
  const set = useNotesSettings((s) => s.set);
  const [all, setAll] = useState<TemplateInfo[]>([]);
  const [reload, setReload] = useState(0);
  const drawingsOn = useManaged((m) => featureOn(m.features, Feature.Drawings));
  const decksOn = useManaged((m) => featureOn(m.features, Feature.Presentations));
  const readOnly = useSync((s) => (vault ? infoOf(s, vault.id).readOnly : true));

  useEffect(() => {
    if (!vault) return;
    let stale = false;
    void api.templates
      .list(vault.id)
      .then((l) => !stale && setAll(l))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [vault, reload]);

  const ofKind = (kind: TemplateKind): TemplateInfo[] => all.filter((tp) => tp.kind === kind);
  // Daily, unique and new notes are notes: the templates of drawings and presentations are not theirs.
  const templates = ofKind('note');
  const own = all.filter((tp) => tp.source === 'vault');

  const remove = async (tp: TemplateInfo): Promise<void> => {
    if (!(await dialog.confirm(t('settings.daily.deleteTemplate'), templateLabel(tp), true)))
      return;
    try {
      await deleteEntry(tp.path);
    } catch (e) {
      await dialog.error(e);
    }
    setReload((n) => n + 1);
  };
  const create = async (): Promise<void> => {
    try {
      await newTemplate();
    } catch (e) {
      await dialog.error(e);
    }
    setReload((n) => n + 1);
  };

  if (!vault) return <p className="muted">{t('settings.needsVault')}</p>;
  return (
    <>
      <h4>{t('settings.daily.templates')}</h4>
      <p className="muted small">
        {t('settings.daily.templatesWhere')} <code>{CONFIG_DIR}/templates</code>
      </p>
      <p className="muted small">
        <code>{'{{date}} {{date:FORMAT}} {{time}} {{time:FORMAT}} {{title}}'}</code>{' '}
        {t('settings.daily.variablesHelp')}
      </p>
      <TemplateSelect
        id="new-note-template"
        label={t('settings.daily.newNoteTemplate')}
        k="newNoteTemplate"
        options={templates}
      />
      {drawingsOn && (
        <TemplateSelect
          id="new-drawing-template"
          label={t('settings.daily.newDrawingTemplate')}
          k="newDrawingTemplate"
          options={ofKind('drawing')}
        />
      )}
      {decksOn && (
        <TemplateSelect
          id="new-presentation-template"
          label={t('settings.daily.newPresentationTemplate')}
          k="newPresentationTemplate"
          options={ofKind('presentation')}
        />
      )}
      <ul className="template-list" aria-label={t('settings.daily.templates')}>
        {own.map((tp) => (
          <li key={tp.ref} className="row">
            <span>
              {templateLabel(tp)}{' '}
              <span className="muted small">{t(`templates.kind_${tp.kind}`)}</span>
            </span>
            <span className="row-controls">
              <button
                type="button"
                onClick={() => useAppStore.getState().openNote(tp.path, { newTab: true })}
              >
                {t('settings.daily.openTemplate')}
              </button>
              <button type="button" disabled={readOnly} onClick={() => void remove(tp)}>
                {t('settings.daily.deleteTemplate')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {own.length === 0 && <p className="muted small">{t('settings.daily.noTemplates')}</p>}
      <p>
        <button type="button" disabled={readOnly} onClick={() => void create()}>
          {t('commands.template_new')}
        </button>
      </p>

      <h4>{t('settings.daily.daily')}</h4>
      <Text id="daily-folder" label={t('settings.daily.folder')} k="dailyFolder" />
      <Text id="daily-format" label={t('settings.daily.format')} k="dailyFormat" />
      <TemplateSelect
        id="daily-template"
        label={t('settings.daily.template')}
        k="dailyTemplate"
        options={templates}
      />

      <h4>{t('settings.daily.unique')}</h4>
      <Text id="unique-folder" label={t('settings.daily.folder')} k="uniqueFolder" />
      <Text id="unique-format" label={t('settings.daily.format')} k="uniqueFormat" />
      <TemplateSelect
        id="unique-template"
        label={t('settings.daily.template')}
        k="uniqueTemplate"
        options={templates}
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
