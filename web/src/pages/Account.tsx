import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, InlineError, TextField, useToast } from '@nodus/ui';
import { describeError } from '../api/errors';
import { useDeleteMyAccount, useExportMyData } from '../api/account';
import { useMe, useVaults } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { downloadBlob } from '../export/download';

export function AccountPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { signOut } = useAuth();
  const me = useMe();
  const vaults = useVaults();
  const exportData = useExportMyData();
  const deleteAccount = useDeleteMyAccount();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const username = me.data?.username ?? '';
  const privateVaults = (vaults.data?.items ?? []).filter((v) => v.kind === 'private');
  const canDelete = username !== '' && confirm === username && (privateVaults.length === 0 || ack);

  const close = () => {
    setOpen(false);
    setConfirm('');
    setAck(false);
    setError(null);
  };

  const download = () => {
    setExportError(null);
    exportData.mutate(undefined, {
      onSuccess: (blob) => {
        downloadBlob(blob, `nodus-account-${new Date().toISOString().slice(0, 10)}.json`);
        toast.push(t('account.exportDone'));
      },
      onError: (e) => setExportError(describeError(e, t)),
    });
  };

  const remove = () => {
    deleteAccount.mutate(
      { confirm, ...(privateVaults.length > 0 ? { acknowledge_data_loss: ack } : {}) },
      {
        onSuccess: () => {
          close();
          signOut();
        },
        onError: (e) => setError(describeError(e, t)),
      },
    );
  };

  return (
    <>
      <h1>{t('account.title')}</h1>

      <section aria-labelledby="account-export" className="nd-stack">
        <h2 id="account-export">{t('account.exportTitle')}</h2>
        <p>{t('account.exportBody')}</p>
        <div>
          <Button onClick={download} disabled={exportData.isPending}>
            {t('account.exportButton')}
          </Button>
        </div>
        {exportError && <InlineError>{exportError}</InlineError>}
      </section>

      <section aria-labelledby="account-delete" className="nd-stack">
        <h2 id="account-delete">{t('account.deleteTitle')}</h2>
        <p>{t('account.deleteBody')}</p>
        <div>
          <Button variant="danger" onClick={() => setOpen(true)} disabled={!me.data}>
            {t('account.deleteButton')}
          </Button>
        </div>
      </section>

      {open && (
        <Dialog
          title={t('account.dialogTitle')}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                onClick={remove}
                disabled={!canDelete || deleteAccount.isPending}
              >
                {t('account.dialogConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('account.dialogBody')}</p>
          {privateVaults.length > 0 && (
            <div role="alert" className="nd-stack">
              <p>
                <strong>{t('account.privateWarning', { count: privateVaults.length })}</strong>
              </p>
              <ul>
                {privateVaults.map((v) => (
                  <li key={v.id}>{v.name}</li>
                ))}
              </ul>
              <label>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{' '}
                {t('account.privateAck')}
              </label>
            </div>
          )}
          <TextField
            label={t('account.confirmLabel', { username })}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
          />
          {error && <InlineError>{error}</InlineError>}
        </Dialog>
      )}
    </>
  );
}
