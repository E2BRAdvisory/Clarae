// Files & links settings added in M6: where new notes and attachments go, confirmation before
// trashing, and whether embedded searches list their own note. Rows honour the keys an
// administrator locked, like the other settings.
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { editorKeyOf, isLocked, useManaged } from '../state/managed';
import { useSettings, type EditorSettings } from '../state/settings';
import type { AttachmentLocation, NoteLocation } from './locations';
import { Icon } from '../shell/icons';

function Row({
  field,
  label,
  id,
  children,
}: {
  field: keyof EditorSettings;
  label: string;
  id: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const key = editorKeyOf(field);
  const locked = useManaged((m) => (key ? isLocked(m.locked, `editor.${key}`) : false));
  return (
    <div className={`row${locked ? ' managed' : ''}`}>
      <label htmlFor={id}>{label}</label>
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

function Check({ field, label }: { field: 'confirmDelete' | 'queryIncludeHost'; label: string }) {
  const value = useSettings((s) => s.editor[field]);
  const setEditor = useSettings((s) => s.setEditor);
  return (
    <Row field={field} label={label} id={field}>
      <input
        id={field}
        type="checkbox"
        checked={value}
        onChange={(e) => setEditor({ [field]: e.target.checked })}
      />
    </Row>
  );
}

export function FilesExtra() {
  const { t } = useTranslation();
  const editor = useSettings((s) => s.editor);
  const setEditor = useSettings((s) => s.setEditor);
  return (
    <>
      <Row field="newNoteLocation" label={t('settings.newNoteLocation')} id="newNoteLocation">
        <select
          id="newNoteLocation"
          value={editor.newNoteLocation}
          onChange={(e) => setEditor({ newNoteLocation: e.target.value as NoteLocation })}
        >
          <option value="folder">{t('settings.locationFolder')}</option>
          <option value="current">{t('settings.locationCurrent')}</option>
        </select>
      </Row>
      <Row
        field="attachmentLocation"
        label={t('settings.attachmentLocation')}
        id="attachmentLocation"
      >
        <select
          id="attachmentLocation"
          value={editor.attachmentLocation}
          onChange={(e) => setEditor({ attachmentLocation: e.target.value as AttachmentLocation })}
        >
          <option value="folder">{t('settings.locationFolder')}</option>
          <option value="current">{t('settings.locationCurrent')}</option>
          <option value="subfolder">{t('settings.attachmentSubfolder')}</option>
        </select>
      </Row>
      <Check field="confirmDelete" label={t('settings.confirmDelete')} />
      <Check field="queryIncludeHost" label={t('settings.queryIncludeHost')} />
    </>
  );
}
