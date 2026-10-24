import { useTranslation } from 'react-i18next';
import { Badge, EmptyState, Table } from '@nodus/ui';
import type { Schemas } from '@nodus/api-client';
import { useVaults } from '../api/queries';
import { formatBytes, formatDay } from '../format';
import { QueryState } from './QueryState';

function VaultsTable({ vaults, caption }: { vaults: Schemas['Vault'][]; caption: string }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th scope="col">{t('vaults.colName')}</th>
          <th scope="col">{t('vaults.colKind')}</th>
          <th scope="col" className="nd-num">
            {t('vaults.colSize')}
          </th>
          <th scope="col" className="nd-num">
            {t('vaults.colFiles')}
          </th>
          <th scope="col" className="nd-num">
            {t('vaults.colSeq')}
          </th>
          <th scope="col">{t('vaults.colCreated')}</th>
        </tr>
      </thead>
      <tbody>
        {vaults.map((v) => (
          <tr key={v.id}>
            <th scope="row">{v.name}</th>
            <td>
              <Badge tone={v.kind === 'private' ? 'warn' : 'neutral'}>
                {v.kind === 'private' ? t('vaults.kindPrivate') : t('vaults.kindShared')}
              </Badge>
            </td>
            <td className="nd-num">{formatBytes(v.total_bytes, loc)}</td>
            <td className="nd-num">{v.file_count.toLocaleString(loc)}</td>
            <td className="nd-num">{v.last_seq.toLocaleString(loc)}</td>
            <td>{formatDay(v.created_at, loc)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function VaultsPage() {
  const { t } = useTranslation();
  const vaults = useVaults();
  return (
    <>
      <h1>{t('vaults.title')}</h1>
      <QueryState query={vaults}>
        {(list) =>
          list.items.length === 0 && list.mounts.length === 0 ? (
            <EmptyState title={t('vaults.empty')}>{t('vaults.emptyHint')}</EmptyState>
          ) : (
            <div className="nd-stack">
              {list.items.length > 0 && (
                <VaultsTable vaults={list.items} caption={t('vaults.title')} />
              )}
              {list.mounts.length > 0 && (
                <VaultsTable vaults={list.mounts} caption={t('vaults.mounts')} />
              )}
            </div>
          )
        }
      </QueryState>
    </>
  );
}
