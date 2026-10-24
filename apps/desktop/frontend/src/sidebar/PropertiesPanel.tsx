import { useTranslation } from 'react-i18next';
import { useActiveNote } from '../state/activeNote';
import { infoOf, useSync } from '../state/sync';
import { NoteProperties } from '../workspace/NoteProperties';
import { PropertyKeysPanel } from './PropertyKeysPanel';

/** Properties of the open note (editable) and, below, every property used in the vault. */
export function PropertiesPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const note = useActiveNote((s) => s.note);
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);
  return (
    <div className="content properties-panel">
      {note && note.vaultId === vaultId ? (
        <fieldset className="row-controls" disabled={readOnly}>
          <NoteProperties
            key={note.path}
            vaultId={vaultId}
            path={note.path}
            text={note.text}
            prepare={note.prepare}
            onChanged={note.reload}
          />
        </fieldset>
      ) : (
        <div className="muted pad">{t('properties.noNote')}</div>
      )}
      <h4>{t('properties.vault')}</h4>
      <PropertyKeysPanel vaultId={vaultId} />
    </div>
  );
}
