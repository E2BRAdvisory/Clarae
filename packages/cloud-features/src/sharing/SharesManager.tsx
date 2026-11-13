import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Dialog, EmptyState, InlineError } from '@clarae/ui';
import { cloudKeys, describeError } from '../CloudVaultsTable';
import { useFeatureFlag } from '../featureFlags';
import { formatDay } from '../format';
import { createT, type TFunction } from '../i18n';
import type { CloudPort, NewShare, Share, ShareUpdate } from '../port';
import { GrantEditor } from './GrantEditor';
import { EditShareDialog, NewShareDialog, NewShareInsideDialog } from './ShareDialogs';
import { useSharePages } from './useSharePages';

export interface SharesManagerProps {
  port: CloudPort;
  lang?: string | undefined;
  /** Only the shares of this cloud vault (the workbench's "Share…" dialog of the open vault). */
  vaultId?: string | undefined;
  /** Offer "New share" (default true); a host with its own creation flow turns it off. */
  canCreate?: boolean | undefined;
  /** Called after every change, so the host refreshes what it shows elsewhere. */
  onChanged?: (() => void) | undefined;
}

/** The type of a share, as a badge. */
export function shareType(t: TFunction, s: Share): string {
  return t(`shares.type_${s.resource_type}`);
}

/** The owner of the vault has no `my_permission`; a manager has one and cannot revoke. */
export const isOwnerOf = (s: Share): boolean => !s.my_permission;

/**
 * A manager (not the owner) may share again inside a vault or folder share they manage (ADR-0041
 * §8); a document share has nothing inside it to pick, so only the server-side rule covers it.
 */
export const canShareInside = (s: Share): boolean =>
  !isOwnerOf(s) &&
  s.my_permission === 'manager' &&
  s.my_status !== 'pending' &&
  s.resource_type !== 'file';

type Pending =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'inside'; share: Share }
  | { kind: 'edit'; share: Share }
  | { kind: 'revoke'; share: Share };

/**
 * The shares the user created or manages (§2.6.4, ADR-0037 §2): creation of a share of a whole
 * shared vault or of one of its folders (private vaults are never offered, D-02), creation by a
 * manager inside a share they manage (ADR-0041 §8), rename and expiry, the people and groups with
 * their level, revoke. Honours the `sharing` feature flag.
 */
export function SharesManager({
  port,
  lang,
  vaultId,
  canCreate = true,
  onChanged,
}: SharesManagerProps) {
  const t = useMemo(() => createT(lang), [lang]);
  const qc = useQueryClient();
  const flag = useFeatureFlag(port, 'sharing');
  const sharingOn = flag.on && flag.ready;
  // The shares of one vault can be on any page: that view reads them all.
  const pages = useSharePages(port, 'owned', { enabled: sharingOn, all: !!vaultId });
  const owned = pages.query;
  const vaults = useQuery({
    queryKey: cloudKeys.vaults(port),
    queryFn: () => port.listVaults(),
    enabled: sharingOn && canCreate,
  });
  const [pending, setPending] = useState<Pending>({ kind: 'none' });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [status, setStatus] = useState('');

  if (!sharingOn)
    return (
      <div className="mbcf mbcf-shares">
        <p className="mbcf-muted">{flag.ready ? t('shares.disabled') : t('common.loading')}</p>
      </div>
    );

  const close = () => {
    setPending({ kind: 'none' });
    setDialogError('');
  };
  const changed = async () => {
    await qc.invalidateQueries({ queryKey: cloudKeys.shares(port) });
    onChanged?.();
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setDialogError('');
    try {
      const message = await fn();
      close();
      setStatus(message);
      await changed();
    } catch (e) {
      setDialogError(describeError(t, e, 'share'));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = (input: NewShare) =>
    void run(async () => {
      const s = await port.createShare(input);
      setOpen((cur) => new Set(cur).add(s.id));
      return t('shares.created', { name: s.display_name });
    });
  const update = (share: Share, change: ShareUpdate) =>
    void run(async () => {
      const s = await port.updateShare(share.id, change);
      return t('shares.updated', { name: s.display_name });
    });
  const revoke = (share: Share) =>
    void run(async () => {
      await port.revokeShare(share.id);
      return t('shares.revoked', { name: share.display_name });
    });

  const list = pages.shares.filter((s) => !vaultId || s.vault_id === vaultId);
  return (
    <div className="mbcf mbcf-shares">
      {canCreate && (
        <div className="mbcf-toolbar">
          <Button
            variant="primary"
            onClick={() => {
              setStatus('');
              setPending({ kind: 'new' });
            }}
          >
            {t('shares.new')}
          </Button>
        </div>
      )}
      <p className="mbcf-status" role="status">
        {status}
      </p>
      {owned.isPending ? (
        <p className="mbcf-muted">{t('common.loading')}</p>
      ) : owned.isError ? (
        <InlineError>{describeError(t, owned.error, 'share')}</InlineError>
      ) : list.length === 0 && !pages.hasMore ? (
        <EmptyState title={t('shares.ownedEmpty')}>
          {canCreate ? t('shares.ownedEmptyHint') : null}
        </EmptyState>
      ) : (
        <ul className="mbcf-cards" aria-label={t('shares.ownedTitle')}>
          {list.map((s) => {
            const expanded = open.has(s.id);
            const expires = s.expires_at ? formatDay(s.expires_at, lang) : '';
            return (
              <li key={s.id}>
                <section className="nd-card mbcf-card" aria-label={s.display_name}>
                  <div className="mbcf-card__head">
                    <h3>{s.display_name}</h3>
                    <Badge>{shareType(t, s)}</Badge>
                  </div>
                  <p className="mbcf-muted">
                    {t('shares.inVault', { vault: s.vault_name })}
                    {s.path_prefix ? ` · ${s.path_prefix}` : ''} ·{' '}
                    {expires ? t('shares.expires', { date: expires }) : t('shares.noExpiry')}
                  </p>
                  <div className="mbcf-actions mbcf-actions--start">
                    <Button
                      small
                      aria-expanded={expanded}
                      aria-label={t('shares.manageAria', { name: s.display_name })}
                      onClick={() => toggle(s.id)}
                    >
                      {expanded ? t('shares.hide') : t('shares.manage')}
                    </Button>
                    <Button
                      small
                      aria-label={t('shares.editAria', { name: s.display_name })}
                      onClick={() => {
                        setStatus('');
                        setPending({ kind: 'edit', share: s });
                      }}
                    >
                      {t('shares.edit')}
                    </Button>
                    {canCreate && canShareInside(s) && (
                      <Button
                        small
                        aria-label={t('shares.shareInsideAria', { name: s.display_name })}
                        onClick={() => {
                          setStatus('');
                          setPending({ kind: 'inside', share: s });
                        }}
                      >
                        {t('shares.shareInside')}
                      </Button>
                    )}
                    {isOwnerOf(s) && (
                      <Button
                        small
                        variant="danger"
                        aria-label={t('shares.revokeAria', { name: s.display_name })}
                        onClick={() => {
                          setStatus('');
                          setPending({ kind: 'revoke', share: s });
                        }}
                      >
                        {t('shares.revoke')}
                      </Button>
                    )}
                  </div>
                  {!isOwnerOf(s) && <p className="mbcf-muted">{t('shares.managerNote')}</p>}
                  {expanded && <GrantEditor port={port} t={t} share={s} onStatus={setStatus} />}
                </section>
              </li>
            );
          })}
        </ul>
      )}
      {pages.hasMore && !vaultId && !owned.isError && (
        <div className="mbcf-actions mbcf-actions--start">
          <Button disabled={pages.loadingMore} onClick={pages.loadMore}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}

      {pending.kind === 'new' && (
        <NewShareDialog
          t={t}
          vaults={vaults.data ?? []}
          vaultId={vaultId}
          busy={busy || vaults.isPending}
          error={dialogError}
          onCancel={close}
          onSubmit={create}
        />
      )}
      {pending.kind === 'inside' && (
        <NewShareInsideDialog
          t={t}
          within={pending.share}
          busy={busy}
          error={dialogError}
          onCancel={close}
          onSubmit={create}
        />
      )}
      {pending.kind === 'edit' && (
        <EditShareDialog
          t={t}
          share={pending.share}
          busy={busy}
          error={dialogError}
          onCancel={close}
          onSubmit={(change) => update(pending.share, change)}
        />
      )}
      {pending.kind === 'revoke' && (
        <Dialog
          title={t('shares.revokeTitle', { name: pending.share.display_name })}
          onClose={close}
          actions={
            <>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button variant="danger" disabled={busy} onClick={() => revoke(pending.share)}>
                {t('shares.revoke')}
              </Button>
            </>
          }
        >
          <p>{t('shares.revokeBody')}</p>
          {dialogError && <InlineError>{dialogError}</InlineError>}
        </Dialog>
      )}
    </div>
  );
}
