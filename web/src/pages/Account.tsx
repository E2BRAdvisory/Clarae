import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, InlineError, TextField, useToast } from '@memobrain/ui';
import { MyGroups } from '@memobrain/cloud-features';
import { useCloudPort } from '../api/cloud';
import { describeError } from '../api/errors';
import { useDeleteMyAccount, useExportMyData } from '../api/account';
import { useMe, useVaults } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { downloadBlob } from '../export/download';
import { useForgetBrowser } from '../layout/ForgetBrowser';
import { forgetThisBrowserDevice } from '../workbench/device';
import { discardAccountStorage } from '../workbench/forget';
import { accountKey, removeUnownedLegacy, unownedLegacyPresent } from '../workbench/storage';

/**
 * The copies an earlier version kept without an account (storage.ts): nobody can be shown to own
 * them, so they are never opened; here they can be deleted, after a warning.
 */
function LegacyCopies() {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const present = useQuery({
    queryKey: ['workbench', 'legacy-copies'],
    queryFn: () => unownedLegacyPresent().catch(() => false),
    staleTime: Infinity,
  });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!present.data) return null;
  const remove = () => {
    setBusy(true);
    setError(null);
    removeUnownedLegacy()
      .then((r) => {
        if (r.busy) return setError(t('account.legacyBusy'));
        setConfirm(false);
        toast.push(t('account.legacyDone'));
        void qc.invalidateQueries({ queryKey: ['workbench', 'legacy-copies'] });
      })
      .catch((e: unknown) => setError(describeError(e, t)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="nd-stack">
      <h3>{t('account.legacyTitle')}</h3>
      <p>{t('account.legacyBody')}</p>
      <div>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          {t('account.legacyButton')}
        </Button>
      </div>
      {confirm && (
        <Dialog
          title={t('account.legacyConfirmTitle')}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
              <Button variant="danger" onClick={remove} disabled={busy}>
                {t('account.legacyButton')}
              </Button>
            </>
          }
        >
          <p>{t('account.legacyConfirmBody')}</p>
          {error && <InlineError>{error}</InlineError>}
        </Dialog>
      )}
    </div>
  );
}

export function AccountPage() {
  const { t, i18n } = useTranslation();
  const port = useCloudPort();
  const toast = useToast();
  const { user, signOut } = useAuth();
  const me = useMe();
  const vaults = useVaults();
  const exportData = useExportMyData();
  const deleteAccount = useDeleteMyAccount();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [forgetError, setForgetError] = useState<string | null>(null);

  const forgetBrowser = useForgetBrowser({
    subject: user?.sub,
    confirmLabel: t('forget.confirmForget'),
    onDone: () => toast.push(t('account.forgetDone')),
    onError: (e) => setForgetError(describeError(e, t)),
  });
  const forget = () => {
    setForgetError(null);
    forgetBrowser.start();
  };

  const username = me.data?.username ?? '';
  const privateVaults = (vaults.data ?? []).filter((v) => v.kind === 'private');
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
        downloadBlob(blob, `memobrain-account-${new Date().toISOString().slice(0, 10)}.json`);
        toast.push(t('account.exportDone'));
      },
      onError: (e) => setExportError(describeError(e, t)),
    });
  };

  const forgetDeletedAccount = async (): Promise<void> => {
    const subject = user?.sub;
    if (!subject) return;
    const account = await accountKey({ server: location.origin, subject });
    await discardAccountStorage(account);
    await forgetThisBrowserDevice(subject, me.data?.id);
  };

  const remove = () => {
    deleteAccount.mutate(
      { confirm, ...(privateVaults.length > 0 ? { acknowledge_data_loss: ack } : {}) },
      {
        onSuccess: () => {
          close();
          // The account is gone: the copies of its vaults leave this browser too, without asking
          // (changes not uploaded can never be uploaded now), and so does its device registration.
          void forgetDeletedAccount()
            .catch((e: unknown) => console.error('memobrain: forgetting the browser failed:', e))
            .finally(signOut);
        },
        onError: (e) => setError(describeError(e, t)),
      },
    );
  };

  return (
    <>
      <h1>{t('account.title')}</h1>

      <section aria-labelledby="account-groups" className="nd-stack">
        <h2 id="account-groups">{t('account.groupsTitle')}</h2>
        <MyGroups port={port} lang={i18n.language} />
      </section>

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

      <section aria-labelledby="account-browser" className="nd-stack">
        <h2 id="account-browser">{t('account.forgetTitle')}</h2>
        <p>{t('account.forgetBody')}</p>
        <div>
          <Button onClick={forget} disabled={forgetBrowser.working}>
            {t('account.forgetButton')}
          </Button>
        </div>
        {forgetError && <InlineError>{forgetError}</InlineError>}
        {forgetBrowser.dialogs}
        <LegacyCopies />
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
