import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, InlineError } from '@clarae/ui';
import { cloudKeys } from '../CloudVaultsTable';
import { useFeatureFlag } from '../featureFlags';
import { formatDay } from '../format';
import { createT, type TFunction } from '../i18n';
import type { CloudMount, CloudPort } from '../port';
import { permissionLabel } from './GrantEditor';

export interface MountsListProps {
  port: CloudPort;
  lang?: string | undefined;
  /** The heading of the list (default «Shared with me»). */
  title?: string | undefined;
  /** Nothing at all without mounts (InvitationsList shows the group only when it has some). */
  hideWhenEmpty?: boolean | undefined;
  /**
   * Where «Open» of a mount leads, as a link (console: the workbench on the mount, a full page
   * load). A host that opens a mount itself passes `actions` instead.
   */
  openHref?: ((m: CloudMount) => string | undefined) | undefined;
  /**
   * The host's own buttons for a mount (the workbench: its declarative actions «Open» and «Remove
   * from this device» through ActionButton, which hide themselves where they do not apply). The
   * package does not know the host's actions; it gives each mount a slot.
   */
  actions?: ((m: CloudMount) => ReactNode) | undefined;
}

function Mount({
  t,
  lang,
  mount,
  keepsLocalCopy,
  href,
  actions,
}: {
  t: TFunction;
  lang: string | undefined;
  mount: CloudMount;
  keepsLocalCopy: boolean;
  href: string | undefined;
  actions: ReactNode;
}) {
  const expires = mount.expires_at ? formatDay(mount.expires_at, lang) : '';
  // Only a port that keeps copies knows about one whose share is gone (the core).
  const revoked = keepsLocalCopy && Boolean(mount.local?.revoked);
  return (
    <li>
      <section className="nd-card mbcf-card" aria-label={mount.display_name}>
        <div className="mbcf-card__head">
          <h4>{mount.display_name}</h4>
          <Badge>{t(`shares.type_${mount.resource_type}`)}</Badge>
          <Badge>{permissionLabel(t, mount.permission)}</Badge>
          {revoked && <Badge tone="warn">{t('mounts.revoked')}</Badge>}
        </div>
        <p className="mbcf-muted">
          {t('shares.from', { owner: mount.owner_name })}
          {expires ? ` · ${t('shares.expires', { date: expires })}` : ''}
        </p>
        {revoked && <p className="mbcf-muted">{t('mounts.revokedHint')}</p>}
        {(href || actions) && (
          <div className="mbcf-actions mbcf-actions--start">
            {href && (
              // A full page load: the workbench has its own HTML and style sheet (ADR-0029).
              <a
                className="nd-button nd-button--small"
                href={href}
                aria-label={t('mounts.openAria', { name: mount.display_name })}
              >
                {t('mounts.open')}
              </a>
            )}
            {actions}
          </div>
        )}
      </section>
    </li>
  );
}

/**
 * The mounts of the user (§2.6.4, ADR-0045 §7): the shares they accepted, one list on every host.
 * The console opens one in the workbench (`openHref`); the desktop and the web workbench put their
 * own actions in the slot (`actions`) and, since their port keeps a copy on this device
 * (`capabilities.keepsLocalCopy`), also list the copies whose share ended. Honours the `sharing`
 * feature flag: nothing is shown or fetched while it is off (InvitationsList and SharesManager say
 * why).
 */
export function MountsList({
  port,
  lang,
  title,
  hideWhenEmpty = false,
  openHref,
  actions,
}: MountsListProps) {
  const t = useMemo(() => createT(lang), [lang]);
  const flag = useFeatureFlag(port, 'sharing');
  const sharingOn = flag.on && flag.ready;
  const mounts = useQuery({
    queryKey: cloudKeys.mounts(port),
    queryFn: () => port.listMounts(),
    enabled: sharingOn,
  });
  if (!sharingOn) return null;
  const items = mounts.data ?? [];
  if (hideWhenEmpty && (mounts.isPending || (mounts.isSuccess && items.length === 0))) return null;
  const heading = title ?? t('mounts.title');
  return (
    <section className="mbcf mbcf-group mbcf-mounts" aria-label={heading}>
      <h3>{heading}</h3>
      {mounts.isPending ? (
        <p className="mbcf-muted">{t('common.loading')}</p>
      ) : mounts.isError ? (
        <InlineError>
          {t('common.loadFailed', {
            message: mounts.error instanceof Error ? mounts.error.message : String(mounts.error),
          })}
        </InlineError>
      ) : items.length === 0 ? (
        <p className="mbcf-muted">{t('mounts.none')}</p>
      ) : (
        <ul className="mbcf-cards">
          {items.map((m) => (
            <Mount
              key={m.share_id}
              t={t}
              lang={lang}
              mount={m}
              keepsLocalCopy={port.capabilities.keepsLocalCopy}
              href={openHref?.(m)}
              actions={actions?.(m)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
