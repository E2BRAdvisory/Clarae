import { useTranslation } from 'react-i18next';
import { useActiveNote } from '../state/activeNote';
import { NoteProperties } from '../workspace/NoteProperties';
import { PropertyKeysPanel } from './PropertyKeysPanel';

/** Properties of the open note (editable) and, below, every property used in the vault. */
export function PropertiesPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const note = useActiveNote((s) => s.note);
  return (
    <div className="content properties-panel">
      {note && note.vaultId === vaultId ? (
        <NoteProperties
          key={note.path}
          vaultId={vaultId}
          path={note.path}
          text={note.text}
          prepare={note.prepare}
          onChanged={note.reload}
        />
      ) : (
        <div className="muted pad">{t('properties.noNote')}</div>
      )}
      <h4>{t('properties.vault')}</h4>
      <PropertyKeysPanel vaultId={vaultId} />
    </div>
  );
}
