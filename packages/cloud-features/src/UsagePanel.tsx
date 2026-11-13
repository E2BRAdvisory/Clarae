import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, InlineError, QuotaBar, Table, serverQuotaLevel } from '@clarae/ui';
import { cloudKeys, describeError } from './CloudVaultsTable';
import { formatBytes } from './format';
import { createT } from './i18n';
import type { CloudPort } from './port';

export interface UsagePanelProps {
  port: CloudPort;
  lang?: string | undefined;
}

/**
 * The account's storage (§2.8.2, ADR-0037 §2): the bar and the message follow the level the server
 * computed from the administrator's thresholds, never a threshold of the client; below, the space
 * taken by each vault.
 */
export function UsagePanel({ port, lang }: UsagePanelProps) {
  const t = useMemo(() => createT(lang), [lang]);
  const usage = useQuery({ queryKey: cloudKeys.usage(port), queryFn: () => port.getUsage() });
  const vaults = useQuery({ queryKey: cloudKeys.vaults(port), queryFn: () => port.listVaults() });

  if (usage.isPending) return <p className="mbcf mbcf-muted">{t('common.loading')}</p>;
  if (usage.isError)
    return (
      <div className="mbcf">
        <InlineError>{describeError(t, usage.error)}</InlineError>
      </div>
    );

  const u = usage.data;
  const unlimited = u.quota_bytes < 0;
  const percent =
    unlimited || u.quota_bytes === 0 ? 0 : Math.round((u.used_bytes / u.quota_bytes) * 100);
  const rows = [...(vaults.data ?? [])].sort((a, b) => b.total_bytes - a.total_bytes);
  const total = rows.reduce((n, v) => n + v.total_bytes, 0);
  const shareOf = (bytes: number) =>
    t('usage.percent', { percent: total > 0 ? Math.round((bytes / total) * 100) : 0 });

  return (
    <div className="mbcf mbcf-usage">
      <QuotaBar
        usedBytes={u.used_bytes}
        quotaBytes={u.quota_bytes}
        level={serverQuotaLevel(u.level)}
        label={t('usage.barLabel')}
        caption={
          unlimited
            ? t('usage.captionUnlimited', { used: formatBytes(u.used_bytes, lang) })
            : t('usage.caption', {
                used: formatBytes(u.used_bytes, lang),
                quota: formatBytes(u.quota_bytes, lang),
              })
        }
        {...(unlimited
          ? {}
          : { percentText: t('usage.percent', { percent: Math.min(percent, 100) }) })}
      />
      <p className="mbcf-level" data-level={u.level} role={u.level === 'ok' ? undefined : 'status'}>
        {t(`usage.level_${u.level}`)}
      </p>
      <p className="mbcf-muted">{t('usage.note')}</p>

      {vaults.isError ? (
        <InlineError>{describeError(t, vaults.error)}</InlineError>
      ) : rows.length === 0 ? (
        vaults.isPending ? null : (
          <p className="mbcf-muted">{t('usage.noVaults')}</p>
        )
      ) : (
        <Table caption={t('usage.byVault')}>
          <thead>
            <tr>
              <th scope="col">{t('usage.colVault')}</th>
              <th scope="col">{t('vaults.colKind')}</th>
              <th scope="col" className="nd-num">
                {t('vaults.colFiles')}
              </th>
              <th scope="col" className="nd-num">
                {t('vaults.colSize')}
              </th>
              <th scope="col" className="nd-num">
                {t('usage.colShare')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <th scope="row">{v.name}</th>
                <td>
                  <Badge tone={v.kind === 'private' ? 'warn' : 'neutral'}>
                    {v.kind === 'private' ? t('vaults.kindPrivate') : t('vaults.kindShared')}
                  </Badge>
                </td>
                <td className="nd-num">{v.file_count.toLocaleString(lang)}</td>
                <td className="nd-num">{formatBytes(v.total_bytes, lang)}</td>
                <td className="nd-num">{shareOf(v.total_bytes)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
