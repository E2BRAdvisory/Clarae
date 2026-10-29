import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type DeviceInfo } from '../app/api';
import { dialog } from '../ui/dialogs';
import { i18next } from '../i18n';
import { Icon } from '../shell/icons';

const fmtBytes = (n: number): string => {
  if (n < 0) return '∞';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = new Intl.NumberFormat(i18next.language, {
    maximumFractionDigits: v >= 10 || i === 0 ? 0 : 1,
  }).format(v);
  return `${num} ${units[i]}`;
};

/** Storage usage and the account's devices (list and revoke), shown under Settings > Cloud. */
export function AccountDevices() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const usageQ = useQuery({ queryKey: ['account', 'usage'], queryFn: () => api.sync.usage() });
  const devicesQ = useQuery({
    queryKey: ['account', 'devices'],
    queryFn: () => api.sync.devices(),
  });
  const usage = usageQ.data ?? null;
  const devices = devicesQ.data ?? [];
  const failure = usageQ.error ?? devicesQ.error;
  const error = failure instanceof Error ? failure.message : failure ? String(failure) : '';

  const revoke = async (d: DeviceInfo) => {
    if (!(await dialog.confirm(t('cloud.revoke'), t('cloud.revokeText', { name: d.name }), true)))
      return;
    try {
      await api.sync.revokeDevice(d.id);
      await qc.invalidateQueries({ queryKey: ['account'] });
    } catch (e) {
      await dialog.error(e);
    }
  };

  if (error) return <div className="muted small">{error}</div>;
  const pct =
    usage && usage.quotaBytes > 0
      ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100))
      : 0;
  return (
    <>
      {usage && (
        <div className="usage">
          <h3>{t('cloud.storage')}</h3>
          <div
            className={`meter usage-${usage.level}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={t('cloud.storage')}
          >
            <span style={{ width: `${usage.quotaBytes < 0 ? 0 : pct}%` }} />
          </div>
          <div className="muted small">
            {t('cloud.usageOf', {
              used: fmtBytes(usage.usedBytes),
              quota: fmtBytes(usage.quotaBytes),
            })}
          </div>
        </div>
      )}
      <h3>{t('cloud.devices')}</h3>
      <ul className="devices">
        {devices.map((d) => (
          <li key={d.id}>
            <span>
              <strong>{d.name}</strong>{' '}
              <span className="muted small">
                {d.platform}
                {d.appVersion ? ` · ${d.appVersion}` : ''}
              </span>
              {d.current && <span className="badge">{t('cloud.thisDevice')}</span>}
            </span>
            {!d.current && (
              <button
                className="icon"
                aria-label={`${t('cloud.revoke')} ${d.name}`}
                onClick={() => void revoke(d)}
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
