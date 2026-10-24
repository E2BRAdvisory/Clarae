import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { usePropertyKeys } from '../state/queries';

/** Every frontmatter property used in the vault, with usage counts. */
export function PropertyKeysPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const { data = [] } = usePropertyKeys(vaultId);
  const search = useAppStore((s) => s.search);
  return (
    <div className="content tree" aria-label={t('properties.vault')}>
      {data.length === 0 && <div className="muted pad">{t('properties.none')}</div>}
      {data.map((k) => (
        <div key={k.key} className="node" onClick={() => search(`[${k.key}]`)} title={k.kind}>
          <span className="name">{k.key}</span>
          <span className="count">{k.count}</span>
        </div>
      ))}
    </div>
  );
}
