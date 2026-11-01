import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Dialog, EmptyState, InlineError, Table, TextField } from '@memobrain/ui';
import { formatBytes, formatDay, purgeDate } from './format';
import { createT, type TFunction } from './i18n';
import { NAME_MAX, NewVaultDialog } from './NewVaultDialog';
import { errorCode, type CloudPort, type CloudVault, type VaultKind } from './port';

export interface CloudVaultsTableProps {
  port: CloudPort;
  /** BCP 47 language of the host ("it", "en-US", …); the package has its own strings. */
  lang?: string | undefined;
  /** Accessible name of the table of live vaults (default "Cloud vaults"). */
  caption?: string | undefined;
  /** Where "Open" leads (console: the workbench page); no link when it returns undefined. */
  openHref?: ((v: CloudVault) => string | undefined) | undefined;
  /** One more column of the host (console: the ZIP export). */
  extraColumn?: { header: string; render: (v: CloudVault) => ReactNode } | undefined;
  /**
   * Replaces the built-in "New vault" dialog with the host's own flow (desktop: connect the open
   * folder). Without it and without `capabilities.createShared`, there is no "New vault" button.
   */
  onNew?: (() => void) | undefined;
  /** Creates a private vault named so (console: opens the browser workbench on its creation route). */
  onCreatePrivate?: ((name: string) => void) | undefined;
  /** Called after every change, so the host refreshes what it shows elsewhere (usage, mounts). */
  onChanged?: (() => void) | undefined;
  /** A vault that cannot be deleted from here (web workbench: the one open in the page). */
  isCurrent?: ((v: CloudVault) => boolean) | undefined;
}

/** The query keys of the package: one cache per port. */
export const cloudKeys = {
  all: (port: CloudPort) => ['cloud-features', port.id] as const,
  vaults: (port: CloudPort) => ['cloud-features', port.id, 'vaults'] as const,
  deleted: (port: CloudPort) => ['cloud-features', port.id, 'vaults', 'deleted'] as const,
  devices: (port: CloudPort) => ['cloud-features', port.id, 'devices'] as const,
  usage: (port: CloudPort) => ['cloud-features', port.id, 'usage'] as const,
  shares: (port: CloudPort) => ['cloud-features', port.id, 'shares'] as const,
  sharesOf: (port: CloudPort, scope: 'owned' | 'received') =>
    ['cloud-features', port.id, 'shares', scope] as const,
  directory: (port: CloudPort, type: string, q: string) =>
    ['cloud-features', port.id, 'directory', type, q] as const,
  groups: (port: CloudPort) => ['cloud-features', port.id, 'groups'] as const,
};

/** What an error is about, for the words of NOT_FOUND and VALIDATION_FAILED. */
export type ErrorSubject = 'vault' | 'share' | 'device';

/** An error of a port in the user's words: the known application codes, or the message. */
export function describeError(t: TFunction, e: unknown, subject: ErrorSubject = 'vault'): string {
  switch (errorCode(e)) {
    case 'NAME_IN_USE':
      return t('errors.NAME_IN_USE');
    case 'NOT_FOUND':
      return subject === 'share'
        ? t('errors.NOT_FOUND_share')
        : subject === 'device'
          ? t('errors.NOT_FOUND_device')
          : t('errors.NOT_FOUND');
    case 'VALIDATION_FAILED':
      return subject === 'share'
        ? t('errors.VALIDATION_FAILED_share')
        : t('errors.VALIDATION_FAILED');
    case 'FORBIDDEN':
      return t('errors.FORBIDDEN');
    case 'VAULT_ENCRYPTED':
      return t('errors.VAULT_ENCRYPTED');
    default:
      return t('errors.generic', { message: e instanceof Error ? e.message : String(e) });
  }
}

type Pending =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'rename'; vault: CloudVault }
  | { kind: 'delete'; vault: CloudVault };

/**
 * The account's cloud vaults with their lifecycle (§2.6.1, ADR-0037 §2): list, creation, rename,
 * soft delete with a confirmation that says what happens, and the deleted vaults with restore. The
 * same component on every host: only the port and the host's callbacks differ.
 */
export function CloudVaultsTable({
  port,
  lang,
  caption,
  openHref,
  extraColumn,
  onNew,
  onCreatePrivate,
  onChanged,
  isCurrent,
}: CloudVaultsTableProps) {
  const t = useMemo(() => createT(lang), [lang]);
  const qc = useQueryClient();
  const live = useQuery({ queryKey: cloudKeys.vaults(port), queryFn: () => port.listVaults() });
  const deleted = useQuery({
    queryKey: cloudKeys.deleted(port),
    queryFn: () => port.listDeletedVaults(),
  });
  const [pending, setPending] = useState<Pending>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [rowError, setRowError] = useState('');
  const [status, setStatus] = useState('');
  const [newName, setNewName] = useState('');
  const caps = port.capabilities;
  const canCreate = Boolean(onNew) || caps.createShared;

  const close = () => {
    setPending({ kind: 'none' });
    setDialogError('');
  };
  const changed = async () => {
    await qc.invalidateQueries({ queryKey: cloudKeys.all(port) });
    onChanged?.();
  };
  /** Runs a change from a dialog: the dialog closes on success and shows the error otherwise. */
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setDialogError('');
    try {
      const message = await fn();
      close();
      setStatus(message);
      await changed();
    } catch (e) {
      setDialogError(describeError(t, e));
    } finally {
      setBusy(false);
    }
  };

  const create = (name: string, kind: VaultKind) => {
    if (kind === 'private') {
      close();
      onCreatePrivate?.(name);
      return;
    }
    void run(async () => {
      const v = await port.createVault(name, 'shared');
      return t('vaults.created', { name: v.name });
    });
  };

  const restore = async (v: CloudVault) => {
    setRowError('');
    setStatus('');
    try {
      const r = await port.restoreVault(v.id);
      setStatus(t('vaults.restored', { name: r.name }));
      await changed();
    } catch (e) {
      setRowError(describeError(t, e));
    }
  };

  const loc = lang;
  const vaults = live.data ?? [];
  const gone = deleted.data ?? [];
  const kindBadge = (v: CloudVault) => (
    <Badge tone={v.kind === 'private' ? 'warn' : 'neutral'}>
      {v.kind === 'private' ? t('vaults.kindPrivate') : t('vaults.kindShared')}
    </Badge>
  );

  return (
    <div className="mbcf mbcf-vaults">
      {canCreate && (
        <div className="mbcf-toolbar">
          <Button
            variant="primary"
            onClick={() => {
              setStatus('');
              if (onNew) onNew();
              else setPending({ kind: 'new' });
            }}
          >
            {t('vaults.new')}
          </Button>
        </div>
      )}
      <p className="mbcf-status" role="status">
        {status}
      </p>
      {rowError && <InlineError>{rowError}</InlineError>}

      {live.isPending ? (
        <p className="mbcf-muted">{t('vaults.loading')}</p>
      ) : live.isError ? (
        <InlineError>{t('vaults.loadFailed', { message: String(live.error) })}</InlineError>
      ) : vaults.length === 0 ? (
        <EmptyState title={t('vaults.empty')}>{t('vaults.emptyHint')}</EmptyState>
      ) : (
        <Table caption={caption ?? t('vaults.caption')}>
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
              <th scope="col">{t('vaults.colCreated')}</th>
              {extraColumn && (
                <th scope="col">
                  <span className="nd-visually-hidden">{extraColumn.header}</span>
                </th>
              )}
              <th scope="col">
                <span className="nd-visually-hidden">{t('vaults.colActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {vaults.map((v) => {
              const href = openHref?.(v);
              const current = isCurrent?.(v) ?? false;
              return (
                <tr key={v.id}>
                  <th scope="row">{v.name}</th>
                  <td>{kindBadge(v)}</td>
                  <td className="nd-num">{formatBytes(v.total_bytes, loc)}</td>
                  <td className="nd-num">{v.file_count.toLocaleString(loc)}</td>
                  <td>{formatDay(v.created_at, loc)}</td>
                  {extraColumn && <td>{extraColumn.render(v)}</td>}
                  <td>
                    <div className="mbcf-actions">
                      {href && (
                        // A full page load: the workbench has its own HTML and style sheet (ADR-0029).
                        <a
                          className="nd-button nd-button--small"
                          href={href}
                          aria-label={t('vaults.openAria', { name: v.name })}
                        >
                          {t('vaults.open')}
                        </a>
                      )}
                      <Button
                        small
                        aria-label={t('vaults.renameAria', { name: v.name })}
                        onClick={() => {
                          setStatus('');
                          setNewName(v.name);
                          setPending({ kind: 'rename', vault: v });
                        }}
                      >
                        {t('vaults.rename')}
                      </Button>
                      <Button
                        small
                        variant="danger"
                        disabled={current}
                        title={current ? t('vaults.current') : undefined}
                        aria-label={t('vaults.deleteAria', { name: v.name })}
                        onClick={() => {
                          setStatus('');
                          setPending({ kind: 'delete', vault: v });
                        }}
                      >
                        {t('vaults.delete')}
                      </Button>
                    </div>
                    {current && <span className="mbcf-muted mbcf-note">{t('vaults.current')}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {gone.length > 0 && (
        <div className="mbcf-deleted">
          <Table caption={t('deleted.title')}>
            <thead>
              <tr>
                <th scope="col">{t('vaults.colName')}</th>
                <th scope="col">{t('vaults.colKind')}</th>
                <th scope="col">{t('deleted.colDeleted')}</th>
                <th scope="col">{t('deleted.colPurge')}</th>
                <th scope="col">
                  <span className="nd-visually-hidden">{t('vaults.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {gone.map((v) => {
                const purge = purgeDate(v.deleted_at, caps.deletedRetentionDays);
                return (
                  <tr key={v.id}>
                    <th scope="row">{v.name}</th>
                    <td>{kindBadge(v)}</td>
                    <td>{formatDay(v.deleted_at, loc)}</td>
                    <td>{purge ? formatDay(purge, loc) : t('deleted.purgeUnknown')}</td>
                    <td>
                      <Button
                        small
                        aria-label={t('deleted.restoreAria', { name: v.name })}
                        onClick={() => void restore(v)}
                      >
                        {t('deleted.restore')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="mbcf-muted">
            {t('deleted.intro')}
            {caps.keepsLocalCopy ? ` ${t('deleted.relink')}` : ''}
          </p>
        </div>
      )}

      {pending.kind === 'new' && (
        <NewVaultDialog
          t={t}
          capabilities={{
            createShared: caps.createShared,
            createPrivate: caps.createPrivate && Boolean(onCreatePrivate),
          }}
          error={dialogError}
          busy={busy}
          onCancel={close}
          onSubmit={create}
        />
      )}

      {pending.kind === 'rename' && (
        <Dialog
          title={t('rename.title')}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>{t('vaults.cancel')}</Button>
              <Button
                variant="primary"
                disabled={
                  busy ||
                  newName.trim() === '' ||
                  newName.trim().length > NAME_MAX ||
                  newName.trim() === pending.vault.name
                }
                onClick={() =>
                  void run(async () => {
                    const v = await port.renameVault(pending.vault.id, newName.trim());
                    return t('vaults.renamed', { name: v.name });
                  })
                }
              >
                {t('vaults.save')}
              </Button>
            </>
          }
        >
          <TextField
            label={t('rename.label')}
            hint={t('rename.hint')}
            value={newName}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(e) => setNewName(e.target.value)}
          />
          {dialogError && <InlineError>{dialogError}</InlineError>}
        </Dialog>
      )}

      {pending.kind === 'delete' && (
        <Dialog
          title={t('delete.title', { name: pending.vault.name })}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>{t('vaults.cancel')}</Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await port.deleteVault(pending.vault.id);
                    return t('vaults.deleted', { name: pending.vault.name });
                  })
                }
              >
                {t('delete.confirm')}
              </Button>
            </>
          }
        >
          <p>
            {caps.deletedRetentionDays !== undefined
              ? t('delete.retentionDays', { count: caps.deletedRetentionDays })
              : t('delete.retention')}
          </p>
          <p>{t('delete.devices')}</p>
          {caps.keepsLocalCopy && <p>{t('delete.localCopy')}</p>}
          {caps.keepsLocalCopy && pending.vault.kind === 'private' && <p>{t('delete.private')}</p>}
          {dialogError && <InlineError>{dialogError}</InlineError>}
        </Dialog>
      )}
    </div>
  );
}
