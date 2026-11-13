import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge, Card, QuotaBar, Table, quotaLevel, quotaPercent } from '@clarae/ui';
import { useStorageOverview } from '../../api/admin';
import { formatBytes, formatDay } from '../../format';
import { QueryState } from '../QueryState';

type Trend = { day: string; total_bytes: number }[];

const W = 600;
const H = 180;
const PAD = { l: 8, r: 8, t: 12, b: 20 };

/** Inline SVG line chart of the total storage, with a data table as the text alternative. */
export function TrendChart({ trend }: { trend: Trend }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  if (trend.length === 0) return <p className="nd-muted">{t('admin.storage.trendEmpty')}</p>;
  const values = trend.map((p) => p.total_bytes);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const x = (i: number) =>
    trend.length === 1 ? W / 2 : PAD.l + (i * (W - PAD.l - PAD.r)) / (trend.length - 1);
  const y = (v: number) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  const points = trend.map((p, i) => `${x(i).toFixed(1)},${y(p.total_bytes).toFixed(1)}`).join(' ');
  const first = trend[0] as Trend[number];
  const last = trend[trend.length - 1] as Trend[number];
  const summary = t('admin.storage.trendSummary', {
    from: formatDay(first.day, loc),
    to: formatDay(last.day, loc),
    start: formatBytes(first.total_bytes, loc),
    end: formatBytes(last.total_bytes, loc),
  });
  return (
    <div>
      <svg
        className="admin-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={summary}
        data-testid="trend-chart"
      >
        <line
          className="admin-chart__axis"
          x1={PAD.l}
          x2={W - PAD.r}
          y1={H - PAD.b}
          y2={H - PAD.b}
        />
        <polyline className="admin-chart__line" points={points} fill="none" />
        {trend.map((p, i) => (
          <circle
            key={p.day}
            className="admin-chart__dot"
            cx={x(i)}
            cy={y(p.total_bytes)}
            r={2.5}
          />
        ))}
        <text className="admin-chart__label" x={PAD.l} y={H - 4}>
          {formatDay(first.day, loc)}
        </text>
        <text className="admin-chart__label" x={W - PAD.r} y={H - 4} textAnchor="end">
          {formatDay(last.day, loc)}
        </text>
        <text className="admin-chart__label" x={PAD.l} y={10}>
          {formatBytes(max, loc)}
        </text>
      </svg>
      <details>
        <summary>{t('admin.storage.trendTable')}</summary>
        <Table caption={t('admin.storage.trendTitle')}>
          <thead>
            <tr>
              <th scope="col">{t('admin.storage.day')}</th>
              <th scope="col" className="nd-num">
                {t('admin.storage.total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {trend.map((p) => (
              <tr key={p.day}>
                <th scope="row">{formatDay(p.day, loc)}</th>
                <td className="nd-num">{formatBytes(p.total_bytes, loc)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </details>
    </div>
  );
}

export function StoragePage() {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  const overview = useStorageOverview();
  return (
    <section aria-labelledby="admin-storage">
      <h2 id="admin-storage">{t('admin.sections.storage')}</h2>
      <QueryState query={overview}>
        {(o) => (
          <div className="nd-stack">
            <dl className="admin-stats">
              <div className="nd-card admin-stat">
                <dt>{t('admin.storage.totalUsed')}</dt>
                <dd>{formatBytes(o.total_used_bytes, loc)}</dd>
              </div>
              <div className="nd-card admin-stat">
                <dt>{t('admin.storage.users')}</dt>
                <dd>{o.user_count.toLocaleString(loc)}</dd>
              </div>
              <div className="nd-card admin-stat">
                <dt>{t('admin.storage.defaultQuota')}</dt>
                <dd>
                  {o.default_quota_bytes < 0
                    ? t('common.unlimited')
                    : formatBytes(o.default_quota_bytes, loc)}
                </dd>
              </div>
              <div
                className="nd-card admin-stat"
                data-level={o.users_over_warn > 0 ? 'warn' : 'ok'}
              >
                <dt>{t('admin.storage.overWarn')}</dt>
                <dd>
                  {o.users_over_warn.toLocaleString(loc)}{' '}
                  {o.users_over_warn > 0 && <Badge tone="warn">{t('admin.storage.warnTag')}</Badge>}
                </dd>
              </div>
              <div
                className="nd-card admin-stat"
                data-level={o.users_over_critical > 0 ? 'critical' : 'ok'}
              >
                <dt>{t('admin.storage.overCritical')}</dt>
                <dd>
                  {o.users_over_critical.toLocaleString(loc)}{' '}
                  {o.users_over_critical > 0 && (
                    <Badge tone="danger">{t('admin.storage.criticalTag')}</Badge>
                  )}
                </dd>
              </div>
            </dl>

            <Card aria-labelledby="admin-top">
              <h3 id="admin-top">{t('admin.storage.top')}</h3>
              {o.top_consumers.length === 0 ? (
                <p className="nd-muted">{t('admin.storage.topEmpty')}</p>
              ) : (
                <Table caption={t('admin.storage.top')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('admin.users.colUser')}</th>
                      <th scope="col">{t('admin.storage.usedOfQuota')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.top_consumers.map((c) => {
                      const unlimited = c.quota_bytes < 0;
                      const pct = Math.round(quotaPercent(c.used_bytes, c.quota_bytes));
                      return (
                        <tr key={c.user_id} data-level={quotaLevel(c.used_bytes, c.quota_bytes)}>
                          <th scope="row">
                            <Link to={`/admin/users/${c.user_id}`}>{c.username}</Link>
                          </th>
                          <td className="admin-quota-cell">
                            <QuotaBar
                              usedBytes={c.used_bytes}
                              quotaBytes={c.quota_bytes}
                              label={t('admin.storage.barLabel', { name: c.username })}
                              caption={
                                unlimited
                                  ? t('usage.captionUnlimited', {
                                      used: formatBytes(c.used_bytes, loc),
                                    })
                                  : t('usage.caption', {
                                      used: formatBytes(c.used_bytes, loc),
                                      quota: formatBytes(c.quota_bytes, loc),
                                    })
                              }
                              {...(unlimited
                                ? {}
                                : { percentText: t('usage.percent', { percent: pct }) })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card aria-labelledby="admin-trend">
              <h3 id="admin-trend">{t('admin.storage.trendTitle')}</h3>
              <TrendChart trend={o.trend} />
            </Card>
          </div>
        )}
      </QueryState>
    </section>
  );
}
