import { useTranslation } from 'react-i18next';
import { Card, QuotaBar, quotaLevel, quotaPercent } from '@memobrain/ui';
import { useUsage } from '../api/queries';
import { formatBytes } from '../format';
import { QueryState } from './QueryState';

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const usage = useUsage();
  const loc = i18n.language;
  return (
    <>
      <h1>{t('usage.title')}</h1>
      <QueryState query={usage}>
        {(u) => {
          const unlimited = u.quota_bytes < 0;
          const level = quotaLevel(u.used_bytes, u.quota_bytes);
          const percent = Math.round(quotaPercent(u.used_bytes, u.quota_bytes));
          return (
            <Card>
              <QuotaBar
                usedBytes={u.used_bytes}
                quotaBytes={u.quota_bytes}
                label={t('usage.barLabel')}
                caption={
                  unlimited
                    ? t('usage.captionUnlimited', { used: formatBytes(u.used_bytes, loc) })
                    : t('usage.caption', {
                        used: formatBytes(u.used_bytes, loc),
                        quota: formatBytes(u.quota_bytes, loc),
                      })
                }
                {...(unlimited ? {} : { percentText: t('usage.percent', { percent }) })}
              />
              <p role={level === 'ok' ? undefined : 'status'}>
                {t(`usage.level${level[0]?.toUpperCase()}${level.slice(1)}`)}
              </p>
              <p className="nd-muted">{t('usage.note')}</p>
            </Card>
          );
        }}
      </QueryState>
    </>
  );
}
