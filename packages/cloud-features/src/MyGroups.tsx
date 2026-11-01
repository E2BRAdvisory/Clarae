import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineError, Table } from '@memobrain/ui';
import { cloudKeys, describeError } from './CloudVaultsTable';
import { createT } from './i18n';
import type { CloudPort } from './port';

export interface MyGroupsProps {
  port: CloudPort;
  lang?: string | undefined;
}

/**
 * The groups the user belongs to (`GET /me/groups`, spec §3.5). Groups live only in the cloud's
 * database (D-05): an administrator manages them, people share with them.
 */
export function MyGroups({ port, lang }: MyGroupsProps) {
  const t = useMemo(() => createT(lang), [lang]);
  const groups = useQuery({
    queryKey: cloudKeys.groups(port),
    queryFn: () => port.listMyGroups(),
    enabled: Boolean(port.capabilities.myGroups),
  });
  if (!port.capabilities.myGroups) return null;
  const items = groups.data ?? [];
  return (
    <div className="mbcf mbcf-groups">
      {groups.isPending ? (
        <p className="mbcf-muted">{t('common.loading')}</p>
      ) : groups.isError ? (
        <InlineError>{describeError(t, groups.error)}</InlineError>
      ) : items.length === 0 ? (
        <p className="mbcf-muted">{t('groups.empty')}</p>
      ) : (
        <Table caption={t('groups.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('groups.colName')}</th>
              <th scope="col">{t('groups.colDescription')}</th>
              <th scope="col">{t('groups.colRole')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((g) => (
              <tr key={g.id}>
                <th scope="row">{g.name}</th>
                <td>{g.description || '—'}</td>
                <td>{t(`groups.role_${g.member_role}`)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="mbcf-muted">{t('groups.note')}</p>
    </div>
  );
}
