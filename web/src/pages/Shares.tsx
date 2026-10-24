import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  InlineError,
  SelectField,
  Table,
  TextField,
  useToast,
} from '@nodus/ui';
import { describeError } from '../api/errors';
import {
  useAnswerInvitation,
  useDeleteGrant,
  useDirectorySearch,
  useMe,
  usePutGrant,
  useRevokeShare,
  useShares,
  type Grant,
  type PrincipalType,
  type Share,
  type SharePermission,
} from '../api/queries';
import { formatDay } from '../format';
import { QueryState } from './QueryState';

const PERMISSIONS: SharePermission[] = ['viewer', 'editor', 'manager'];

function statusTone(status: Grant['status']): 'ok' | 'warn' | 'neutral' {
  return status === 'accepted' ? 'ok' : status === 'pending' ? 'warn' : 'neutral';
}

/* ---- Add a grant: directory search, then pick ------------------------- */

function AddGrant({ share }: { share: Share }) {
  const { t } = useTranslation();
  const toast = useToast();
  const put = usePutGrant();
  const [type, setType] = useState<PrincipalType>('user');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [permission, setPermission] = useState<SharePermission>('viewer');
  const [error, setError] = useState<string | null>(null);
  const results = useDirectorySearch(type, query);
  const granted = new Set((share.grants ?? []).map((g) => `${g.principal_type}:${g.principal_id}`));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQuery(input.trim());
  };
  const add = (id: string) => {
    setError(null);
    put.mutate(
      { shareId: share.id, principalType: type, principalId: id, permission },
      {
        onSuccess: () => toast.push(t('shares.grantSavedToast')),
        onError: (err) => setError(describeError(err, t)),
      },
    );
  };

  return (
    <form onSubmit={submit} aria-label={t('shares.addTitle')}>
      <h4>{t('shares.addTitle')}</h4>
      <div className="nd-row">
        <SelectField
          label={t('shares.addType')}
          value={type}
          onChange={(e) => {
            setType(e.target.value as PrincipalType);
            setQuery('');
          }}
        >
          <option value="user">{t('shares.principalUser')}</option>
          <option value="group">{t('shares.principalGroup')}</option>
        </SelectField>
        <TextField
          label={t('shares.searchLabel')}
          hint={t('shares.searchHint')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <SelectField
          label={t('shares.addPermission')}
          value={permission}
          onChange={(e) => setPermission(e.target.value as SharePermission)}
        >
          {PERMISSIONS.map((p) => (
            <option key={p} value={p}>
              {t(`shares.permission_${p}`)}
            </option>
          ))}
        </SelectField>
        <Button type="submit" disabled={input.trim().length < 2}>
          {t('shares.search')}
        </Button>
      </div>
      {error && <InlineError>{error}</InlineError>}
      {query.length >= 2 && results.isError && (
        <InlineError>{describeError(results.error, t)}</InlineError>
      )}
      {query.length >= 2 && results.data && (
        <ul aria-label={t('shares.search')}>
          {results.data.length === 0 && <li className="nd-muted">{t('shares.noResults')}</li>}
          {results.data.map((r) => (
            <li key={r.id} className="nd-row">
              <span>
                {r.name}
                {r.detail ? <span className="nd-muted"> ({r.detail})</span> : null}
              </span>
              <Button
                small
                aria-label={t('shares.addAria', { name: r.name })}
                disabled={put.isPending || granted.has(`${type}:${r.id}`)}
                onClick={() => add(r.id)}
              >
                {t('shares.add')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/* ---- Grants table -------------------------------------------------------- */

function GrantsTable({ share }: { share: Share }) {
  const { t } = useTranslation();
  const toast = useToast();
  const put = usePutGrant();
  const del = useDeleteGrant();
  const [error, setError] = useState<string | null>(null);
  const grants = share.grants ?? [];

  const change = (g: Grant, permission: SharePermission) => {
    setError(null);
    put.mutate(
      {
        shareId: share.id,
        principalType: g.principal_type,
        principalId: g.principal_id,
        permission,
      },
      {
        onSuccess: () => toast.push(t('shares.grantSavedToast')),
        onError: (err) => setError(describeError(err, t)),
      },
    );
  };
  const remove = (g: Grant) => {
    setError(null);
    del.mutate(
      { shareId: share.id, principalType: g.principal_type, principalId: g.principal_id },
      {
        onSuccess: () => toast.push(t('shares.grantRemovedToast')),
        onError: (err) => setError(describeError(err, t)),
      },
    );
  };

  return (
    <div className="nd-stack">
      {error && <InlineError>{error}</InlineError>}
      {grants.length === 0 ? (
        <p className="nd-muted">{t('shares.noGrants')}</p>
      ) : (
        <Table caption={t('shares.grants')}>
          <thead>
            <tr>
              <th scope="col">{t('shares.colWho')}</th>
              <th scope="col">{t('shares.colPermission')}</th>
              <th scope="col">{t('shares.colStatus')}</th>
              <th scope="col">
                <span className="nd-visually-hidden">{t('shares.removeGrant')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={`${g.principal_type}:${g.principal_id}`}>
                <th scope="row">
                  {g.principal_name}{' '}
                  <Badge>
                    {g.principal_type === 'group'
                      ? t('shares.principalGroup')
                      : t('shares.principalUser')}
                  </Badge>
                </th>
                <td>
                  <select
                    className="nd-select"
                    aria-label={t('shares.permissionFor', { name: g.principal_name })}
                    value={g.permission}
                    disabled={put.isPending}
                    onChange={(e) => change(g, e.target.value as SharePermission)}
                  >
                    {PERMISSIONS.map((p) => (
                      <option key={p} value={p}>
                        {t(`shares.permission_${p}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Badge tone={statusTone(g.status)}>{t(`shares.status_${g.status}`)}</Badge>
                </td>
                <td>
                  <Button
                    small
                    variant="danger"
                    aria-label={t('shares.removeGrantAria', { name: g.principal_name })}
                    disabled={del.isPending}
                    onClick={() => remove(g)}
                  >
                    {t('shares.removeGrant')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <AddGrant share={share} />
    </div>
  );
}

/* ---- Owned shares --------------------------------------------------------- */

function OwnedShare({ share, isOwner }: { share: Share; isOwner: boolean }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const revoke = useRevokeShare();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expires = formatDay(share.expires_at, i18n.language);

  const confirmRevoke = () =>
    revoke.mutate(share.id, {
      onSuccess: () => {
        toast.push(t('shares.revokedToast'));
        setConfirming(false);
      },
      onError: (err) => setError(describeError(err, t)),
    });

  return (
    <Card aria-label={share.display_name}>
      <div className="nd-row">
        <h3>{share.display_name}</h3>
        <Badge>{t(`shares.type_${share.resource_type}`)}</Badge>
        <span className="nd-muted">{t('shares.inVault', { vault: share.vault_name })}</span>
        {expires && <span className="nd-muted">{t('shares.expires', { date: expires })}</span>}
      </div>
      <div className="nd-row">
        <Button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('shares.hide') : t('shares.manage')}
        </Button>
        {isOwner && (
          <Button
            variant="danger"
            aria-label={`${t('shares.revoke')}: ${share.display_name}`}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            {t('shares.revoke')}
          </Button>
        )}
      </div>
      {open && <GrantsTable share={share} />}
      {confirming && (
        <Dialog
          title={t('shares.revokeTitle')}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button variant="danger" disabled={revoke.isPending} onClick={confirmRevoke}>
                {t('shares.revoke')}
              </Button>
            </>
          }
        >
          <p>{t('shares.revokeBody', { name: share.display_name })}</p>
          {error && <InlineError>{error}</InlineError>}
        </Dialog>
      )}
    </Card>
  );
}

function OwnedSection() {
  const { t } = useTranslation();
  const owned = useShares('owned');
  const me = useMe();
  return (
    <section aria-labelledby="shares-owned">
      <h2 id="shares-owned">{t('shares.owned')}</h2>
      <QueryState query={owned}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title={t('shares.ownedEmpty')}>{t('shares.ownedEmptyHint')}</EmptyState>
          ) : (
            <div>
              {list.map((s) => (
                <OwnedShare key={s.id} share={s} isOwner={me.data?.id === s.owner_id} />
              ))}
            </div>
          )
        }
      </QueryState>
    </section>
  );
}

/* ---- Received shares: invitations and mounts -------------------------------- */

function ReceivedRow({ share }: { share: Share }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const answer = useAnswerInvitation();
  const [error, setError] = useState<string | null>(null);
  const expires = formatDay(share.expires_at, i18n.language);

  const reply = (accept: boolean) => {
    setError(null);
    // The card unmounts as soon as the list refreshes (the invitation moves to another section),
    // and callbacks given to mutate() are dropped with it: the toast must not depend on them.
    answer
      .mutateAsync({ shareId: share.id, accept })
      .then(() => toast.push(t(accept ? 'shares.acceptedToast' : 'shares.declinedToast')))
      .catch((err: unknown) => setError(describeError(err, t)));
  };

  return (
    <Card aria-label={share.display_name}>
      <div className="nd-row">
        <h3>{share.display_name}</h3>
        <Badge>{t(`shares.type_${share.resource_type}`)}</Badge>
        {share.my_permission && <Badge>{t(`shares.permission_${share.my_permission}`)}</Badge>}
        {share.my_status && share.my_status !== 'pending' && (
          <Badge tone={statusTone(share.my_status)}>{t(`shares.status_${share.my_status}`)}</Badge>
        )}
      </div>
      <p className="nd-muted">
        {t('shares.from', { owner: share.owner_name })} ·{' '}
        {t('shares.inVault', { vault: share.vault_name })}
        {expires ? ` · ${t('shares.expires', { date: expires })}` : ''}
      </p>
      {error && <InlineError>{error}</InlineError>}
      {share.my_status === 'pending' && (
        <div className="nd-row">
          <Button
            variant="primary"
            disabled={answer.isPending}
            aria-label={`${t('shares.accept')}: ${share.display_name}`}
            onClick={() => reply(true)}
          >
            {t('shares.accept')}
          </Button>
          <Button
            disabled={answer.isPending}
            aria-label={`${t('shares.decline')}: ${share.display_name}`}
            onClick={() => reply(false)}
          >
            {t('shares.decline')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function ReceivedSection() {
  const { t } = useTranslation();
  const received = useShares('received');
  return (
    <section aria-labelledby="shares-received">
      <h2 id="shares-received">{t('shares.received')}</h2>
      <QueryState query={received}>
        {(list) => {
          if (list.length === 0) return <EmptyState title={t('shares.receivedEmpty')} />;
          const pending = list.filter((s) => s.my_status === 'pending');
          const accepted = list.filter((s) => s.my_status === 'accepted');
          const declined = list.filter((s) => s.my_status === 'declined');
          return (
            <div>
              {pending.length > 0 && (
                <>
                  <h3>{t('shares.invitations')}</h3>
                  {pending.map((s) => (
                    <ReceivedRow key={s.id} share={s} />
                  ))}
                </>
              )}
              {accepted.length > 0 && (
                <>
                  <h3>{t('shares.mounts')}</h3>
                  {accepted.map((s) => (
                    <ReceivedRow key={s.id} share={s} />
                  ))}
                </>
              )}
              {declined.length > 0 && (
                <>
                  <h3>{t('shares.declined')}</h3>
                  {declined.map((s) => (
                    <ReceivedRow key={s.id} share={s} />
                  ))}
                </>
              )}
            </div>
          );
        }}
      </QueryState>
    </section>
  );
}

export function SharesPage() {
  const { t } = useTranslation();
  return (
    <>
      <h1>{t('shares.title')}</h1>
      <div className="nd-stack">
        <ReceivedSection />
        <OwnedSection />
      </div>
    </>
  );
}
