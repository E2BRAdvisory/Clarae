import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineError } from '@memobrain/ui';
import { cloudKeys, describeError } from '../CloudVaultsTable';
import { useFeatureFlag } from '../featureFlags';
import { formatDay } from '../format';
import { createT, type TFunction } from '../i18n';
import type { CloudMount, CloudPort, Share } from '../port';
import { permissionLabel, statusTone } from './GrantEditor';
import { MountsList } from './MountsList';
import { shareType } from './SharesManager';
import { useSharePages } from './useSharePages';

export type InvitationSection = 'pending' | 'accepted' | 'declined';

export interface InvitationsListProps {
  port: CloudPort;
  lang?: string | undefined;
  /**
   * Which groups to show (default all). The accepted shares are the mounts: their group is
   * MountsList, which a host may also show on its own (the workbench, with its actions) and then
   * leaves out here.
   */
  sections?: InvitationSection[] | undefined;
  /** Where "Open" of an accepted share leads (console: the workbench on the mount). */
  openHref?: ((m: CloudMount) => string | undefined) | undefined;
  /** Called after an answer (the desktop prepares and lists the mount). */
  onAnswered?: ((s: Share, accepted: boolean) => void) | undefined;
}

function Received({
  t,
  lang,
  share,
  busy,
  onAnswer,
}: {
  t: TFunction;
  lang: string | undefined;
  share: Share;
  busy: boolean;
  onAnswer?: ((accept: boolean) => void) | undefined;
}) {
  const expires = share.expires_at ? formatDay(share.expires_at, lang) : '';
  return (
    <li>
      <section className="nd-card mbcf-card" aria-label={share.display_name}>
        <div className="mbcf-card__head">
          <h4>{share.display_name}</h4>
          <Badge>{shareType(t, share)}</Badge>
          {share.my_permission && <Badge>{permissionLabel(t, share.my_permission)}</Badge>}
          {share.my_status && share.my_status !== 'pending' && (
            <Badge tone={statusTone(share.my_status)}>
              {t(`grants.status_${share.my_status}`)}
            </Badge>
          )}
        </div>
        <p className="mbcf-muted">
          {t('shares.from', { owner: share.owner_name })} ·{' '}
          {t('shares.inVault', { vault: share.vault_name })}
          {expires ? ` · ${t('shares.expires', { date: expires })}` : ''}
        </p>
        {onAnswer && (
          <div className="mbcf-actions mbcf-actions--start">
            <Button
              small
              variant="primary"
              disabled={busy}
              aria-label={t('invitations.acceptAria', { name: share.display_name })}
              onClick={() => onAnswer(true)}
            >
              {t('invitations.accept')}
            </Button>
            <Button
              small
              disabled={busy}
              aria-label={t('invitations.declineAria', { name: share.display_name })}
              onClick={() => onAnswer(false)}
            >
              {t('invitations.decline')}
            </Button>
          </div>
        )}
      </section>
    </li>
  );
}

/**
 * The shares received (§2.6.4, ADR-0037 §2): invitations to accept or decline, the accepted ones and
 * the declined ones. Honours the `sharing` feature flag.
 */
export function InvitationsList({
  port,
  lang,
  sections = ['pending', 'accepted', 'declined'],
  openHref,
  onAnswered,
}: InvitationsListProps) {
  const t = useMemo(() => createT(lang), [lang]);
  const qc = useQueryClient();
  const flag = useFeatureFlag(port, 'sharing');
  const sharingOn = flag.on && flag.ready;
  const pages = useSharePages(port, 'received', { enabled: sharingOn });
  const received = pages.query;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  if (!sharingOn)
    return (
      <div className="mbcf mbcf-invitations">
        <p className="mbcf-muted">{flag.ready ? t('shares.disabled') : t('common.loading')}</p>
      </div>
    );

  const answer = async (s: Share, accept: boolean) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      if (accept) await port.acceptInvitation(s.id);
      else await port.declineInvitation(s.id);
      setStatus(
        t(accept ? 'invitations.acceptedStatus' : 'invitations.declinedStatus', {
          name: s.display_name,
        }),
      );
      await qc.invalidateQueries({ queryKey: cloudKeys.shares(port) });
      onAnswered?.(s, accept);
    } catch (e) {
      setError(describeError(t, e, 'share'));
    } finally {
      setBusy(false);
    }
  };

  const all = pages.shares;
  const by = (st: InvitationSection) => all.filter((s) => (s.my_status ?? 'pending') === st);
  const titles: Record<InvitationSection, string> = {
    pending: t('invitations.title'),
    accepted: t('invitations.accepted'),
    declined: t('invitations.declined'),
  };

  return (
    <div className="mbcf mbcf-invitations">
      <p className="mbcf-status" role="status">
        {status}
      </p>
      {error && <InlineError>{error}</InlineError>}
      {received.isPending ? (
        <p className="mbcf-muted">{t('common.loading')}</p>
      ) : received.isError ? (
        <InlineError>{describeError(t, received.error, 'share')}</InlineError>
      ) : (
        sections.map((st) => {
          // The accepted shares are the mounts: one list on every host (ADR-0045 §7).
          if (st === 'accepted')
            return (
              <MountsList
                key={st}
                port={port}
                lang={lang}
                title={titles.accepted}
                hideWhenEmpty
                openHref={openHref}
              />
            );
          const items = by(st);
          // The invitations always say whether there are any; the other groups only when filled.
          if (st !== 'pending' && items.length === 0) return null;
          return (
            <section key={st} className="mbcf-group" aria-label={titles[st]}>
              <h3>{titles[st]}</h3>
              {items.length === 0 && !pages.hasMore ? (
                <p className="mbcf-muted">{t('invitations.none')}</p>
              ) : (
                <ul className="mbcf-cards">
                  {items.map((s) => (
                    <Received
                      key={s.id}
                      t={t}
                      lang={lang}
                      share={s}
                      busy={busy}
                      onAnswer={st === 'pending' ? (accept) => void answer(s, accept) : undefined}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
      {pages.hasMore && !received.isError && (
        <div className="mbcf-actions mbcf-actions--start">
          <Button disabled={pages.loadingMore} onClick={pages.loadMore}>
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
