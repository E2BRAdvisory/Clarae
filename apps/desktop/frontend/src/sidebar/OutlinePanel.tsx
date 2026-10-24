import { useTranslation } from 'react-i18next';
import { selectActivePath, useAppStore } from '../state/store';
import { useOutline } from '../state/queries';

export function OutlinePanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const path = useAppStore(selectActivePath);
  const openNote = useAppStore((s) => s.openNote);
  const { data = [] } = useOutline(vaultId, path);
  if (!path) return <div className="muted pad">{t('outline.none')}</div>;
  return (
    <div className="content outline" aria-label={t('outline.title')}>
      {data.length === 0 && <div className="muted pad">{t('outline.empty')}</div>}
      {data.map((h, i) => (
        <div
          key={`${h.line}:${i}`}
          className="node"
          style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
          onClick={() => openNote(path, { heading: h.text, line: h.line })}
        >
          <span className="name">{h.text}</span>
        </div>
      ))}
    </div>
  );
}
