import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Card,
  Dialog,
  InlineError,
  SelectField,
  Table,
  TextField,
  useToast,
} from '@nodus/ui';
import {
  useAdminUser,
  useDeleteUser,
  useEffectiveConfig,
  useResetPassword,
  useSetQuota,
  useSetRole,
  useUpdateUser,
  useUserAction,
  useUserDevices,
  useUserSessions,
  useUserVaults,
  type AdminUser,
  type Role,
} from '../../api/admin';
import { formatBytes, formatDate } from '../../format';
import { QueryState } from '../QueryState';
import { adminError } from './adminError';
import { QuotaDialog } from './QuotaDialog';
import { statusTone } from './UsersPage';

/* ---- Sub-tables ---------------------------------------------------------------------------- */

function VaultsPart({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  const vaults = useUserVaults(id);
  return (
    <section aria-labelledby="ud-vaults">
      <h3 id="ud-vaults">{t('admin.user.vaults')}</h3>
      <p className="nd-muted">{t('admin.user.vaultsNote')}</p>
      <QueryState query={vaults}>
        {(list) =>
          list.length === 0 ? (
            <p className="nd-muted">{t('admin.user.vaultsEmpty')}</p>
          ) : (
            <Table caption={t('admin.user.vaults')}>
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
                  <th scope="col">{t('admin.user.vaultState')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((v) => (
                  <tr key={v.id}>
                    <th scope="row">{v.name}</th>
                    <td>
                      {v.kind === 'private' ? t('vaults.kindPrivate') : t('vaults.kindShared')}
                    </td>
                    <td className="nd-num">{formatBytes(v.total_bytes, loc)}</td>
                    <td className="nd-num">{v.file_count.toLocaleString(loc)}</td>
                    <td>{formatDate(v.created_at, loc)}</td>
                    <td>
                      {v.deleted_at ? (
                        <Badge tone="danger">
                          {t('admin.user.deletedOn', { date: formatDate(v.deleted_at, loc) })}
                        </Badge>
                      ) : (
                        <Badge tone="ok">{t('admin.user.vaultActive')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
    </section>
  );
}

function DevicesPart({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  const devices = useUserDevices(id);
  return (
    <section aria-labelledby="ud-devices">
      <h3 id="ud-devices">{t('admin.user.devices')}</h3>
      <QueryState query={devices}>
        {(list) =>
          list.length === 0 ? (
            <p className="nd-muted">{t('admin.user.devicesEmpty')}</p>
          ) : (
            <Table caption={t('admin.user.devices')}>
              <thead>
                <tr>
                  <th scope="col">{t('devices.colName')}</th>
                  <th scope="col">{t('devices.colPlatform')}</th>
                  <th scope="col">{t('devices.colSeen')}</th>
                  <th scope="col">{t('admin.user.vaultState')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id}>
                    <th scope="row">{d.name}</th>
                    <td>{d.platform}</td>
                    <td>{formatDate(d.last_seen_at, loc) ?? t('common.never')}</td>
                    <td>
                      {d.revoked_at ? (
                        <Badge tone="danger">{t('admin.user.revoked')}</Badge>
                      ) : (
                        <Badge tone="ok">{t('admin.user.vaultActive')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
    </section>
  );
}

function SessionsPart({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  const sessions = useUserSessions(id);
  return (
    <section aria-labelledby="ud-sessions">
      <h3 id="ud-sessions">{t('admin.user.sessions')}</h3>
      <QueryState query={sessions}>
        {(list) =>
          list.length === 0 ? (
            <p className="nd-muted">{t('admin.user.sessionsEmpty')}</p>
          ) : (
            <Table caption={t('admin.user.sessions')}>
              <thead>
                <tr>
                  <th scope="col">{t('admin.user.sessionIp')}</th>
                  <th scope="col">{t('admin.user.sessionStarted')}</th>
                  <th scope="col">{t('admin.user.sessionLast')}</th>
                  <th scope="col">{t('admin.user.sessionClients')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">{s.ip_address ?? '—'}</th>
                    <td>{formatDate(s.started, loc)}</td>
                    <td>{formatDate(s.last_access, loc)}</td>
                    <td>{(s.clients ?? []).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
    </section>
  );
}

function EffectiveConfigPart({ id }: { id: string }) {
  const { t } = useTranslation();
  const cfg = useEffectiveConfig(id);
  return (
    <section aria-labelledby="ud-config">
      <h3 id="ud-config">{t('admin.user.effectiveConfig')}</h3>
      <p className="nd-muted">{t('admin.user.effectiveConfigNote')}</p>
      <QueryState query={cfg}>
        {(c) => (
          <div className="nd-stack">
            <p>{t('admin.user.configVersion', { version: c.version })}</p>
            <pre className="admin-json" tabIndex={0} aria-label={t('admin.user.effectiveConfig')}>
              {JSON.stringify(c.config, null, 2)}
            </pre>
            <p>
              {t('admin.user.lockedKeys')}{' '}
              {c.locked_keys.length === 0
                ? t('admin.user.none')
                : c.locked_keys.map((k) => (
                    <code key={k} className="admin-key">
                      {k}
                    </code>
                  ))}
            </p>
          </div>
        )}
      </QueryState>
    </section>
  );
}

/* ---- Actions ------------------------------------------------------------------------------------ */

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  pending,
  error,
  onConfirm,
  onClose,
  children,
  confirmDisabled,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={pending || confirmDisabled === true}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{body}</p>
      {children}
      {error && <InlineError>{error}</InlineError>}
    </Dialog>
  );
}

type Dlg = 'suspend' | 'reset' | 'quota' | 'delete' | null;

function Actions({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const action = useUserAction(user.id);
  const reset = useResetPassword(user.id);
  const setRole = useSetRole(user.id);
  const setQuota = useSetQuota(user.id);
  const del = useDeleteUser();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole_] = useState<Role>(user.role);
  const [typed, setTyped] = useState('');
  const [resetInfo, setResetInfo] = useState<boolean | null>(null);

  const open = (d: Dlg) => {
    setError(null);
    setTyped('');
    setDlg(d);
  };
  const close = () => setDlg(null);
  const fail = (err: unknown) => setError(adminError(err, t));

  const doSuspend = () =>
    action.mutate('suspend', {
      onSuccess: () => {
        toast.push(t('admin.user.suspendedToast'));
        close();
      },
      onError: fail,
    });
  const doActivate = () => {
    setError(null);
    action.mutate('activate', {
      onSuccess: () => toast.push(t('admin.user.activatedToast')),
      onError: fail,
    });
  };
  const doReset = () =>
    reset.mutate(undefined, {
      onSuccess: (r) => {
        setResetInfo(r.email_sent);
        close();
      },
      onError: fail,
    });
  const doRole = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setRole.mutate(role, {
      onSuccess: () => toast.push(t('admin.user.roleSavedToast')),
      onError: fail,
    });
  };
  const doDelete = () =>
    del.mutate(user.id, {
      onSuccess: () => {
        toast.push(t('admin.user.deletedToast', { name: user.username }));
        void navigate('/admin/users');
      },
      onError: fail,
    });

  const quotaText = user.quota_bytes < 0 ? t('common.unlimited') : formatBytes(user.quota_bytes);
  return (
    <Card aria-labelledby="ud-actions">
      <h3 id="ud-actions">{t('admin.user.actions')}</h3>
      {error && dlg === null && <InlineError>{error}</InlineError>}
      <div className="nd-stack">
        <div className="nd-row">
          {user.status === 'suspended' ? (
            <Button disabled={action.isPending} onClick={doActivate}>
              {t('admin.user.activate')}
            </Button>
          ) : (
            <Button variant="danger" onClick={() => open('suspend')}>
              {t('admin.user.suspend')}
            </Button>
          )}
          <Button onClick={() => open('reset')}>{t('admin.user.resetPassword')}</Button>
          <Button variant="danger" onClick={() => open('delete')}>
            {t('admin.user.delete')}
          </Button>
        </div>
        {resetInfo !== null && (
          <p role="status">
            {resetInfo ? t('admin.user.resetSent') : t('admin.user.resetNotSent')}
          </p>
        )}
        <form className="nd-row" onSubmit={doRole} aria-label={t('admin.user.setRole')}>
          <SelectField
            label={t('admin.users.role')}
            value={role}
            onChange={(e) => setRole_(e.target.value as Role)}
          >
            <option value="user">{t('admin.roles.user')}</option>
            <option value="admin">{t('admin.roles.admin')}</option>
          </SelectField>
          <Button type="submit" disabled={setRole.isPending || role === user.role}>
            {t('admin.user.setRole')}
          </Button>
        </form>
        <div className="nd-row">
          <span>
            {t('admin.user.quota')}: <strong>{quotaText}</strong>{' '}
            <span className="nd-muted">
              (
              {user.quota_bytes_override === null || user.quota_bytes_override === undefined
                ? t('admin.user.quotaDefault')
                : user.quota_bytes_override < 0
                  ? t('admin.user.quotaOverrideUnlimited')
                  : t('admin.user.quotaOverride')}
              )
            </span>
          </span>
          <Button onClick={() => open('quota')}>{t('admin.user.changeQuota')}</Button>
        </div>
      </div>

      {dlg === 'suspend' && (
        <ConfirmDialog
          title={t('admin.user.suspendTitle')}
          body={t('admin.user.suspendBody', { name: user.username })}
          confirmLabel={t('admin.user.suspend')}
          danger
          pending={action.isPending}
          error={error}
          onConfirm={doSuspend}
          onClose={close}
        />
      )}
      {dlg === 'reset' && (
        <ConfirmDialog
          title={t('admin.user.resetTitle')}
          body={t('admin.user.resetBody', { name: user.username })}
          confirmLabel={t('admin.user.resetPassword')}
          pending={reset.isPending}
          error={error}
          onConfirm={doReset}
          onClose={close}
        />
      )}
      {dlg === 'delete' && (
        <ConfirmDialog
          title={t('admin.user.deleteTitle')}
          body={t('admin.user.deleteBody', { name: user.username })}
          confirmLabel={t('admin.user.delete')}
          danger
          pending={del.isPending}
          confirmDisabled={typed !== user.username}
          error={error}
          onConfirm={doDelete}
          onClose={close}
        >
          <TextField
            label={t('admin.user.deleteType', { name: user.username })}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </ConfirmDialog>
      )}
      {dlg === 'quota' && (
        <QuotaDialog
          title={t('admin.user.quotaTitle', { name: user.username })}
          current={user.quota_bytes_override ?? null}
          pending={setQuota.isPending}
          error={error}
          onClose={close}
          onSubmit={(q) =>
            setQuota.mutate(q, {
              onSuccess: () => {
                toast.push(t('admin.user.quotaSavedToast'));
                close();
              },
              onError: fail,
            })
          }
        />
      )}
    </Card>
  );
}

/* ---- Profile --------------------------------------------------------------------------------------- */

function ProfileForm({ user }: { user: AdminUser }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const update = useUpdateUser(user.id);
  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [email, setEmail] = useState(user.email);
  const [error, setError] = useState<string | null>(null);
  const dirty = displayName !== (user.display_name ?? '') || email !== user.email;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+$/.test(email.trim())) return setError(t('admin.users.createInvalid'));
    update.mutate(
      {
        ...(displayName !== (user.display_name ?? '') ? { display_name: displayName.trim() } : {}),
        ...(email !== user.email ? { email: email.trim() } : {}),
      },
      {
        onSuccess: () => toast.push(t('admin.user.profileSavedToast')),
        onError: (err) => setError(adminError(err, t)),
      },
    );
  };

  return (
    <Card aria-labelledby="ud-profile">
      <h3 id="ud-profile">{t('admin.user.profile')}</h3>
      <form onSubmit={submit} noValidate className="nd-stack">
        <TextField
          label={t('admin.users.displayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <TextField
          label={t('admin.users.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="nd-muted">
          {t('admin.user.usernameIs', { name: user.username })} ·{' '}
          {t('admin.user.createdOn', { date: formatDate(user.created_at, i18n.language) })}
        </p>
        {error && <InlineError>{error}</InlineError>}
        <div className="nd-row">
          <Button type="submit" variant="primary" disabled={!dirty || update.isPending}>
            {t('admin.user.saveProfile')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function UserDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const user = useAdminUser(id);
  return (
    <section aria-labelledby="admin-user">
      <p>
        <Link to="/admin/users">{t('admin.user.back')}</Link>
      </p>
      <QueryState query={user}>
        {(u) => (
          <div className="nd-stack">
            <div className="nd-row admin-head">
              <h2 id="admin-user">{u.display_name || u.username}</h2>
              <Badge tone={statusTone(u.status)}>{t(`admin.status.${u.status}`)}</Badge>
              <Badge>{t(`admin.roles.${u.role}`)}</Badge>
            </div>
            <ProfileForm key={`${u.id}:${u.email}:${u.display_name ?? ''}`} user={u} />
            <Actions key={`${u.id}:${u.role}:${u.status}`} user={u} />
            <VaultsPart id={u.id} />
            <DevicesPart id={u.id} />
            <SessionsPart id={u.id} />
            <EffectiveConfigPart id={u.id} />
          </div>
        )}
      </QueryState>
    </section>
  );
}
