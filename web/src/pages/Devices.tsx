import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Dialog, EmptyState, InlineError, Table, useToast } from '@nodus/ui';
import type { Schemas } from '@nodus/api-client';
import { describeError } from '../api/errors';
import { useDevices, useRevokeDevice } from '../api/queries';
import { formatDate } from '../format';
import { QueryState } from './QueryState';

export function DevicesPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const devices = useDevices();
  const revoke = useRevokeDevice();
  const [target, setTarget] = useState<Schemas['Device'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loc = i18n.language;

  const close = () => {
    setTarget(null);
    setError(null);
  };
  const confirm = () => {
    if (!target) return;
    revoke.mutate(target.id, {
      onSuccess: () => {
        toast.push(t('devices.revokedToast'));
        close();
      },
      onError: (e) => setError(describeError(e, t)),
    });
  };

  return (
    <>
      <h1>{t('devices.title')}</h1>
      <QueryState query={devices}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('devices.empty')}>{t('devices.emptyHint')}</EmptyState>
          ) : (
            <Table caption={t('devices.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('devices.colName')}</th>
                  <th scope="col">{t('devices.colPlatform')}</th>
                  <th scope="col">{t('devices.colVersion')}</th>
                  <th scope="col">{t('devices.colSeen')}</th>
                  <th scope="col">{t('devices.colStatus')}</th>
                  <th scope="col">
                    <span className="nd-visually-hidden">{t('devices.revoke')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id}>
                    <th scope="row">{d.name}</th>
                    <td>{d.platform}</td>
                    <td>{d.app_version ?? '—'}</td>
                    <td>{formatDate(d.last_seen_at, loc) ?? t('common.never')}</td>
                    <td>
                      {d.revoked_at ? (
                        <Badge tone="danger">{t('devices.revoked')}</Badge>
                      ) : (
                        <Badge tone="ok">{t('devices.active')}</Badge>
                      )}
                    </td>
                    <td>
                      {!d.revoked_at && (
                        <Button
                          small
                          variant="danger"
                          aria-label={t('devices.revokeAria', { name: d.name })}
                          onClick={() => setTarget(d)}
                        >
                          {t('devices.revoke')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
      {target && (
        <Dialog
          title={t('devices.confirmTitle')}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button variant="danger" onClick={confirm} disabled={revoke.isPending}>
                {t('devices.revoke')}
              </Button>
            </>
          }
        >
          <p>{t('devices.confirmBody', { name: target.name })}</p>
          {error && <InlineError>{error}</InlineError>}
        </Dialog>
      )}
    </>
  );
}
