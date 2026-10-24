import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Dialog,
  InlineError,
  SelectField,
  Table,
  TextField,
  useToast,
} from '@nodus/ui';
import {
  useAdminGroups,
  useAdminUsers,
  useBulkQuota,
  useCreateUser,
  type AdminUser,
  type Role,
  type UserFilters,
} from '../../api/admin';
import { formatBytes, formatDay } from '../../format';
import { QueryState } from '../QueryState';
import { adminError } from './adminError';
import { QuotaDialog } from './QuotaDialog';

export const PAGE_SIZE = 25;

export function statusTone(status: AdminUser['status']): 'ok' | 'warn' | 'danger' | 'neutral' {
  return status === 'active' ? 'ok' : status === 'suspended' ? 'danger' : 'warn';
}

/* ---- Create user ------------------------------------------------------------------ */

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateUser();
  const formId = useId();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (username.trim() === '' || !/^\S+@\S+$/.test(email.trim()))
      return setError(t('admin.users.createInvalid'));
    if (password !== '' && password.length < 8) return setError(t('admin.users.passwordShort'));
    create.mutate(
      {
        username: username.trim(),
        email: email.trim(),
        role,
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        ...(password ? { temporary_password: password } : {}),
      },
      {
        onSuccess: (u) => {
          toast.push(t('admin.users.createdToast', { name: u.username }));
          onClose();
        },
        onError: (err) => setError(adminError(err, t)),
      },
    );
  };

  return (
    <Dialog
      title={t('admin.users.createTitle')}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" disabled={create.isPending}>
            {t('admin.users.create')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="nd-stack">
        <TextField
          label={t('admin.users.username')}
          value={username}
          autoComplete="off"
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          label={t('admin.users.email')}
          type="email"
          value={email}
          autoComplete="off"
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label={t('admin.users.displayName')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <SelectField
          label={t('admin.users.role')}
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          <option value="user">{t('admin.roles.user')}</option>
          <option value="admin">{t('admin.roles.admin')}</option>
        </SelectField>
        <TextField
          label={t('admin.users.tempPassword')}
          hint={t('admin.users.tempPasswordHint')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <InlineError>{error}</InlineError>}
      </form>
    </Dialog>
  );
}

/* ---- Bulk quota ---------------------------------------------------------------------- */

function BulkQuotaDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const bulk = useBulkQuota();
  const [error, setError] = useState<string | null>(null);
  return (
    <QuotaDialog
      title={t('admin.users.bulkTitle')}
      description={t('admin.users.bulkBody', { count: ids.length })}
      pending={bulk.isPending}
      error={error}
      onClose={onClose}
      onSubmit={(quota) => {
        setError(null);
        bulk.mutate(
          { userIds: ids, quotaBytes: quota },
          {
            onSuccess: (r) => {
              toast.push(t('admin.users.bulkDone', { count: r.updated }));
              onDone();
            },
            onError: (err) => setError(adminError(err, t)),
          },
        );
      }}
    />
  );
}

/* ---- List -------------------------------------------------------------------------------- */

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const loc = i18n.language;
  const groups = useAdminGroups();
  const [filters, setFilters] = useState<UserFilters>({
    q: '',
    status: '',
    role: '',
    group: '',
    sort: 'name',
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState(false);
  const users = useAdminUsers(filters);

  const update = (patch: Partial<UserFilters>) =>
    setFilters((f) => ({ ...f, offset: 0, ...patch }));
  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <section aria-labelledby="admin-users">
      <div className="nd-row admin-head">
        <h2 id="admin-users">{t('admin.sections.users')}</h2>
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('admin.users.create')}
        </Button>
      </div>

      <form
        role="search"
        aria-label={t('admin.users.filters')}
        className="nd-row admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: search.trim() });
        }}
      >
        <TextField
          label={t('admin.users.search')}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SelectField
          label={t('admin.users.status')}
          value={filters.status}
          onChange={(e) => update({ status: e.target.value })}
        >
          <option value="">{t('admin.users.any')}</option>
          <option value="active">{t('admin.status.active')}</option>
          <option value="suspended">{t('admin.status.suspended')}</option>
          <option value="pending">{t('admin.status.pending')}</option>
        </SelectField>
        <SelectField
          label={t('admin.users.role')}
          value={filters.role}
          onChange={(e) => update({ role: e.target.value })}
        >
          <option value="">{t('admin.users.any')}</option>
          <option value="admin">{t('admin.roles.admin')}</option>
          <option value="user">{t('admin.roles.user')}</option>
        </SelectField>
        <SelectField
          label={t('admin.users.group')}
          value={filters.group}
          onChange={(e) => update({ group: e.target.value })}
        >
          <option value="">{t('admin.users.any')}</option>
          {(groups.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('admin.users.sort')}
          value={filters.sort}
          onChange={(e) => update({ sort: e.target.value })}
        >
          <option value="name">{t('admin.users.sortName')}</option>
          <option value="used">{t('admin.users.sortUsed')}</option>
          <option value="created">{t('admin.users.sortCreated')}</option>
        </SelectField>
        <Button type="submit">{t('admin.users.apply')}</Button>
      </form>

      {selected.size > 0 && (
        <div className="nd-row admin-bulk" role="region" aria-label={t('admin.users.bulkRegion')}>
          <span aria-live="polite">{t('admin.users.selected', { count: selected.size })}</span>
          <Button onClick={() => setBulk(true)}>{t('admin.users.bulkQuota')}</Button>
          <Button onClick={() => setSelected(new Set())}>{t('admin.users.clearSelection')}</Button>
        </div>
      )}

      <QueryState query={users}>
        {(list) => {
          if (list.items.length === 0) return <p className="nd-muted">{t('admin.users.empty')}</p>;
          const pageIds = list.items.map((u) => u.id);
          const allOn = pageIds.every((id) => selected.has(id));
          const from = filters.offset + 1;
          const to = filters.offset + list.items.length;
          return (
            <div className="nd-stack">
              <Table caption={t('admin.sections.users')}>
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        type="checkbox"
                        aria-label={t('admin.users.selectAll')}
                        checked={allOn}
                        onChange={(e) => pageIds.forEach((id) => toggle(id, e.target.checked))}
                      />
                    </th>
                    <th scope="col">{t('admin.users.colUser')}</th>
                    <th scope="col">{t('admin.users.role')}</th>
                    <th scope="col">{t('admin.users.status')}</th>
                    <th scope="col" className="nd-num">
                      {t('admin.users.colUsed')}
                    </th>
                    <th scope="col" className="nd-num">
                      {t('admin.users.colQuota')}
                    </th>
                    <th scope="col">{t('admin.users.colLastLogin')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t('admin.users.selectUser', { name: u.username })}
                          checked={selected.has(u.id)}
                          onChange={(e) => toggle(u.id, e.target.checked)}
                        />
                      </td>
                      <th scope="row">
                        <Link to={`/admin/users/${u.id}`}>{u.display_name || u.username}</Link>
                        <div className="nd-muted">
                          {u.username} · {u.email}
                        </div>
                      </th>
                      <td>{t(`admin.roles.${u.role}`)}</td>
                      <td>
                        <Badge tone={statusTone(u.status)}>{t(`admin.status.${u.status}`)}</Badge>
                      </td>
                      <td className="nd-num">{formatBytes(u.used_bytes, loc)}</td>
                      <td className="nd-num">
                        {u.quota_bytes < 0
                          ? t('common.unlimited')
                          : formatBytes(u.quota_bytes, loc)}
                      </td>
                      <td>{formatDay(u.last_login_at, loc) ?? t('common.never')}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <nav className="nd-row" aria-label={t('admin.users.pagination')}>
                <Button
                  disabled={filters.offset === 0}
                  onClick={() =>
                    setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - f.limit) }))
                  }
                >
                  {t('admin.users.prev')}
                </Button>
                <span aria-live="polite">
                  {t('admin.users.range', { from, to, total: list.total })}
                </span>
                <Button
                  disabled={to >= list.total}
                  onClick={() => setFilters((f) => ({ ...f, offset: f.offset + f.limit }))}
                >
                  {t('admin.users.next')}
                </Button>
              </nav>
            </div>
          );
        }}
      </QueryState>

      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      {bulk && (
        <BulkQuotaDialog
          ids={[...selected]}
          onClose={() => setBulk(false)}
          onDone={() => {
            setBulk(false);
            setSelected(new Set());
          }}
        />
      )}
    </section>
  );
}
