import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Dialog, EmptyState, InlineError, Table } from '@clarae/ui';
import { cloudKeys, describeError } from './CloudVaultsTable';
import { formatDay } from './format';
import { createT, type TFunction } from './i18n';
import type { CloudDevice, CloudPort } from './port';

export interface DevicesPanelProps {
  port: CloudPort;
  lang?: string | undefined;
  /**
   * The id of the device this page runs on, when the port cannot tell (console: this browser's
   * registration). A port that knows sets `current` on the device itself (desktop, workbench).
   */
  currentDeviceId?: string | undefined;
  /** Called after a revoke, so the host refreshes what it shows elsewhere. */
  onChanged?: (() => void) | undefined;
}

const PLATFORMS: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

function platformName(t: TFunction, p: string): string {
  if (p === 'web') return t('devices.platformWeb');
  return PLATFORMS[p] ?? p;
}

/**
 * The account's devices with revoke (§2.8, ADR-0037 §2). The device in use is marked and cannot be
 * revoked from here (it would cut the page off its own session): signing out disconnects it.
 */
export function DevicesPanel({ port, lang, currentDeviceId, onChanged }: DevicesPanelProps) {
  const t = useMemo(() => createT(lang), [lang]);
  const qc = useQueryClient();
  const devices = useQuery({
    queryKey: cloudKeys.devices(port),
    queryFn: () => port.listDevices(),
  });
  const [target, setTarget] = useState<CloudDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const isCurrent = (d: CloudDevice) =>
    Boolean(d.current) || (currentDeviceId !== undefined && d.id === currentDeviceId);
  const close = () => {
    setTarget(null);
    setError('');
  };
  const revoke = async (d: CloudDevice) => {
    setBusy(true);
    setError('');
    try {
      await port.revokeDevice(d.id);
      close();
      setStatus(t('devices.revoked', { name: d.name }));
      await qc.invalidateQueries({ queryKey: cloudKeys.devices(port) });
      onChanged?.();
    } catch (e) {
      setError(describeError(t, e, 'device'));
    } finally {
      setBusy(false);
    }
  };

  const items = devices.data ?? [];
  return (
    <div className="mbcf mbcf-devices">
      <p className="mbcf-status" role="status">
        {status}
      </p>
      {devices.isPending ? (
        <p className="mbcf-muted">{t('common.loading')}</p>
      ) : devices.isError ? (
        <InlineError>{describeError(t, devices.error, 'device')}</InlineError>
      ) : items.length === 0 ? (
        <EmptyState title={t('devices.empty')}>{t('devices.emptyHint')}</EmptyState>
      ) : (
        <Table caption={t('devices.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('devices.colName')}</th>
              <th scope="col">{t('devices.colPlatform')}</th>
              <th scope="col">{t('devices.colVersion')}</th>
              <th scope="col">{t('devices.colSeen')}</th>
              <th scope="col">{t('devices.colStatus')}</th>
              <th scope="col">
                <span className="nd-visually-hidden">{t('devices.colActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => {
              const current = isCurrent(d);
              return (
                <tr key={d.id} data-current={current || undefined}>
                  <th scope="row">
                    {d.name} {current && <Badge tone="ok">{t('devices.thisDevice')}</Badge>}
                  </th>
                  <td>{platformName(t, d.platform)}</td>
                  <td>{d.app_version || '—'}</td>
                  <td>{d.last_seen_at ? formatDay(d.last_seen_at, lang) : t('devices.never')}</td>
                  <td>
                    {d.revoked_at ? (
                      <Badge tone="danger">{t('devices.revokedBadge')}</Badge>
                    ) : (
                      <Badge tone="ok">{t('devices.active')}</Badge>
                    )}
                  </td>
                  <td>
                    {current ? (
                      <span className="mbcf-muted mbcf-note">{t('devices.currentNote')}</span>
                    ) : (
                      !d.revoked_at && (
                        <div className="mbcf-actions">
                          <Button
                            small
                            variant="danger"
                            aria-label={t('devices.revokeAria', { name: d.name })}
                            onClick={() => {
                              setStatus('');
                              setTarget(d);
                            }}
                          >
                            {t('devices.revoke')}
                          </Button>
                        </div>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {target && (
        <Dialog
          title={t('devices.confirmTitle')}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button variant="danger" disabled={busy} onClick={() => void revoke(target)}>
                {t('devices.revoke')}
              </Button>
            </>
          }
        >
          <p>{t('devices.confirmBody', { name: target.name })}</p>
          {error && <InlineError>{error}</InlineError>}
        </Dialog>
      )}
    </div>
  );
}
