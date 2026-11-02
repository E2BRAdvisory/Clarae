import { useId, useState, type FormEvent } from 'react';
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
} from '@memobrain/ui';
import {
  useAdminGroup,
  useAdminGroups,
  useAdminUsers,
  useDeleteGroup,
  useGroupMembers,
  useGroupProfiles,
  useProfiles,
  usePutGroupProfiles,
  useRemoveMember,
  useSaveGroup,
  useSetMemberRole,
  type AdminGroup,
  type GroupMember,
  type ProfileAssignment,
} from '../../api/admin';
import { formatDay } from '../../format';
import { QueryState } from '../QueryState';
import { adminError } from './adminError';

/* ---- List + create -------------------------------------------------------------------------- */

function GroupDialog({
  group,
  onClose,
  onSaved,
}: {
  group?: AdminGroup;
  onClose: () => void;
  onSaved?: (g: AdminGroup) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSaveGroup();
  const formId = useId();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim() === '') return setError(t('admin.groups.nameRequired'));
    save.mutate(
      {
        ...(group ? { id: group.id } : {}),
        body: { name: name.trim(), description: description.trim() },
      },
      {
        onSuccess: (g) => {
          toast.push(t(group ? 'admin.groups.savedToast' : 'admin.groups.createdToast'));
          onSaved?.(g);
          onClose();
        },
        onError: (err) => setError(adminError(err, t)),
      },
    );
  };

  return (
    <Dialog
      title={group ? t('admin.groups.editTitle') : t('admin.groups.createTitle')}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" disabled={save.isPending}>
            {group ? t('admin.groups.save') : t('admin.groups.create')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="nd-stack">
        <TextField
          label={t('admin.groups.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={t('admin.groups.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {error && <InlineError>{error}</InlineError>}
      </form>
    </Dialog>
  );
}

export function GroupsPage() {
  const { t, i18n } = useTranslation();
  const groups = useAdminGroups();
  const [creating, setCreating] = useState(false);
  return (
    <section aria-labelledby="admin-groups">
      <div className="nd-row admin-head">
        <h2 id="admin-groups">{t('admin.sections.groups')}</h2>
        <Button variant="primary" onClick={() => setCreating(true)}>
          {t('admin.groups.create')}
        </Button>
      </div>
      <p className="nd-muted">{t('admin.groups.note')}</p>
      <QueryState query={groups}>
        {(list) =>
          list.length === 0 ? (
            <p className="nd-muted">{t('admin.groups.empty')}</p>
          ) : (
            <Table caption={t('admin.sections.groups')}>
              <thead>
                <tr>
                  <th scope="col">{t('admin.groups.name')}</th>
                  <th scope="col">{t('admin.groups.description')}</th>
                  <th scope="col" className="nd-num">
                    {t('admin.groups.members')}
                  </th>
                  <th scope="col">{t('vaults.colCreated')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((g) => (
                  <tr key={g.id}>
                    <th scope="row">
                      <Link to={`/admin/groups/${g.id}`}>{g.name}</Link>
                    </th>
                    <td>{g.description}</td>
                    <td className="nd-num">{g.member_count.toLocaleString(i18n.language)}</td>
                    <td>{formatDay(g.created_at, i18n.language)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryState>
      {creating && <GroupDialog onClose={() => setCreating(false)} />}
    </section>
  );
}

/* ---- Members ------------------------------------------------------------------------------------ */

type Role = GroupMember['member_role'];

function AddMember({ groupId, existing }: { groupId: string; existing: Set<string> }) {
  const { t } = useTranslation();
  const toast = useToast();
  const set = useSetMemberRole(groupId);
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState<string | null>(null);
  const results = useAdminUsers(
    { q, status: '', role: '', group: '', sort: 'name', limit: 10, offset: 0 },
    q !== '',
  );

  return (
    <form
      aria-label={t('admin.groups.addMember')}
      onSubmit={(e) => {
        e.preventDefault();
        setQ(input.trim());
      }}
    >
      <h4>{t('admin.groups.addMember')}</h4>
      <div className="nd-row">
        <TextField
          label={t('admin.groups.searchUser')}
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <SelectField
          label={t('admin.groups.memberRole')}
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          <option value="member">{t('admin.groups.role_member')}</option>
          <option value="manager">{t('admin.groups.role_manager')}</option>
        </SelectField>
        <Button type="submit" disabled={input.trim().length < 1}>
          {t('shares.search')}
        </Button>
      </div>
      {error && <InlineError>{error}</InlineError>}
      {q !== '' && results.data && (
        <ul aria-label={t('shares.search')}>
          {results.data.items.length === 0 && <li className="nd-muted">{t('shares.noResults')}</li>}
          {results.data.items.map((u) => (
            <li key={u.id} className="nd-row">
              <span>
                {u.display_name || u.username} <span className="nd-muted">({u.username})</span>
              </span>
              <Button
                small
                aria-label={t('shares.addAria', { name: u.display_name || u.username })}
                disabled={set.isPending || existing.has(u.id)}
                onClick={() => {
                  setError(null);
                  set.mutate(
                    { userId: u.id, role },
                    {
                      onSuccess: () => toast.push(t('admin.groups.memberAddedToast')),
                      onError: (err) => setError(adminError(err, t)),
                    },
                  );
                }}
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

function MembersPanel({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const members = useGroupMembers(groupId);
  const setRole = useSetMemberRole(groupId);
  const remove = useRemoveMember(groupId);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<GroupMember | null>(null);

  return (
    <section aria-labelledby="gd-members">
      <h3 id="gd-members">{t('admin.groups.members')}</h3>
      {error && <InlineError>{error}</InlineError>}
      <QueryState query={members}>
        {(list) => (
          <div className="nd-stack">
            {list.length === 0 ? (
              <p className="nd-muted">{t('admin.groups.membersEmpty')}</p>
            ) : (
              <Table caption={t('admin.groups.members')}>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.users.colUser')}</th>
                    <th scope="col">{t('admin.groups.memberRole')}</th>
                    <th scope="col">
                      <span className="nd-visually-hidden">{t('admin.groups.removeMember')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((m) => {
                    const name = m.display_name || m.username;
                    return (
                      <tr key={m.user_id}>
                        <th scope="row">
                          {name}
                          <div className="nd-muted">{m.email ?? m.username}</div>
                        </th>
                        <td>
                          <select
                            className="nd-select"
                            aria-label={t('admin.groups.roleFor', { name })}
                            value={m.member_role}
                            disabled={setRole.isPending}
                            onChange={(e) => {
                              setError(null);
                              setRole.mutate(
                                { userId: m.user_id, role: e.target.value as Role },
                                {
                                  onSuccess: () => toast.push(t('admin.groups.roleSavedToast')),
                                  onError: (err) => setError(adminError(err, t)),
                                },
                              );
                            }}
                          >
                            <option value="member">{t('admin.groups.role_member')}</option>
                            <option value="manager">{t('admin.groups.role_manager')}</option>
                          </select>
                        </td>
                        <td>
                          <Button
                            small
                            variant="danger"
                            aria-label={t('admin.groups.removeAria', { name })}
                            onClick={() => setRemoving(m)}
                          >
                            {t('admin.groups.removeMember')}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
            <p className="nd-muted">{t('admin.groups.roleReservedNote')}</p>
            <AddMember groupId={groupId} existing={new Set(list.map((m) => m.user_id))} />
          </div>
        )}
      </QueryState>
      {removing && (
        <Dialog
          title={t('admin.groups.removeTitle')}
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(removing.user_id, {
                    onSuccess: () => {
                      toast.push(t('admin.groups.memberRemovedToast'));
                      setRemoving(null);
                    },
                    onError: (err) => {
                      setError(adminError(err, t));
                      setRemoving(null);
                    },
                  })
                }
              >
                {t('admin.groups.removeMember')}
              </Button>
            </>
          }
        >
          <p>
            {t('admin.groups.removeBody', { name: removing.display_name || removing.username })}
          </p>
        </Dialog>
      )}
    </section>
  );
}

/* ---- Profiles of the group ---------------------------------------------------------------------- */

interface Row {
  key: number;
  profileId: string;
  priority: string;
}

function ProfilesEditor({ groupId, initial }: { groupId: string; initial: ProfileAssignment[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const profiles = useProfiles();
  const put = usePutGroupProfiles(groupId);
  const [seq, setSeq] = useState(initial.length);
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((a, i) => ({ key: i, profileId: a.profile_id, priority: String(a.priority) })),
  );
  const [error, setError] = useState<string | null>(null);
  const assignedIds = new Set(initial.map((a) => a.profile_id));
  const available = (profiles.data ?? []).filter((p) => !p.is_global || assignedIds.has(p.id));

  const patch = (key: number, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const save = () => {
    setError(null);
    const items: ProfileAssignment[] = [];
    for (const r of rows) {
      const n = Number(r.priority);
      if (!r.profileId || r.priority.trim() === '' || !Number.isInteger(n))
        return setError(t('admin.groups.profilesInvalid'));
      items.push({ profile_id: r.profileId, priority: n });
    }
    if (new Set(items.map((i) => i.profile_id)).size !== items.length)
      return setError(t('admin.groups.profilesDuplicate'));
    put.mutate(items, {
      onSuccess: () => toast.push(t('admin.groups.profilesSavedToast')),
      onError: (err) => setError(adminError(err, t)),
    });
  };

  return (
    <div className="nd-stack">
      {rows.length === 0 ? (
        <p className="nd-muted">{t('admin.groups.profilesEmpty')}</p>
      ) : (
        <Table caption={t('admin.groups.profiles')}>
          <thead>
            <tr>
              <th scope="col">{t('admin.groups.profile')}</th>
              <th scope="col">{t('admin.groups.priority')}</th>
              <th scope="col">
                <span className="nd-visually-hidden">{t('admin.groups.removeProfile')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td>
                  <select
                    className="nd-select"
                    aria-label={t('admin.groups.profileRow', { n: i + 1 })}
                    value={r.profileId}
                    onChange={(e) => patch(r.key, { profileId: e.target.value })}
                  >
                    <option value="">{t('admin.groups.chooseProfile')}</option>
                    {available.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="nd-input admin-priority"
                    type="number"
                    step={1}
                    aria-label={t('admin.groups.priorityRow', { n: i + 1 })}
                    value={r.priority}
                    onChange={(e) => patch(r.key, { priority: e.target.value })}
                  />
                </td>
                <td>
                  <Button
                    small
                    variant="danger"
                    aria-label={t('admin.groups.removeProfileRow', { n: i + 1 })}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  >
                    {t('admin.groups.removeProfile')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="nd-muted">{t('admin.groups.priorityHint')}</p>
      {error && <InlineError>{error}</InlineError>}
      <div className="nd-row">
        <Button
          onClick={() => {
            setRows((rs) => [...rs, { key: seq, profileId: '', priority: '0' }]);
            setSeq(seq + 1);
          }}
        >
          {t('admin.groups.addProfile')}
        </Button>
        <Button variant="primary" disabled={put.isPending} onClick={save}>
          {t('admin.groups.saveProfiles')}
        </Button>
      </div>
    </div>
  );
}

function ProfilesPanel({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const assigned = useGroupProfiles(groupId);
  return (
    <section aria-labelledby="gd-profiles">
      <h3 id="gd-profiles">{t('admin.groups.profiles')}</h3>
      <p className="nd-muted">{t('admin.groups.profilesNote')}</p>
      <QueryState query={assigned}>
        {(list) => <ProfilesEditor groupId={groupId} initial={list} />}
      </QueryState>
    </section>
  );
}

/* ---- Detail ------------------------------------------------------------------------------------------ */

export function GroupDetailPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { id = '' } = useParams();
  const group = useAdminGroup(id);
  const del = useDeleteGroup();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-labelledby="admin-group">
      <p>
        <Link to="/admin/groups">{t('admin.groups.back')}</Link>
      </p>
      <QueryState query={group}>
        {(g) => (
          <div className="nd-stack">
            <Card>
              <div className="nd-row admin-head">
                <h2 id="admin-group">{g.name}</h2>
                <Badge>{t('admin.groups.memberCount', { count: g.member_count })}</Badge>
              </div>
              {g.description && <p>{g.description}</p>}
              <div className="nd-row">
                <Button onClick={() => setEditing(true)}>{t('admin.groups.edit')}</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setError(null);
                    setConfirming(true);
                  }}
                >
                  {t('admin.groups.delete')}
                </Button>
              </div>
            </Card>
            <MembersPanel groupId={g.id} />
            <ProfilesPanel groupId={g.id} />
            {editing && <GroupDialog group={g} onClose={() => setEditing(false)} />}
            {confirming && (
              <Dialog
                title={t('admin.groups.deleteTitle')}
                onClose={() => setConfirming(false)}
                actions={
                  <>
                    <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
                    <Button
                      variant="danger"
                      disabled={del.isPending}
                      onClick={() =>
                        del.mutate(g.id, {
                          onSuccess: () => {
                            toast.push(t('admin.groups.deletedToast'));
                            void navigate('/admin/groups');
                          },
                          onError: (err) => setError(adminError(err, t)),
                        })
                      }
                    >
                      {t('admin.groups.delete')}
                    </Button>
                  </>
                }
              >
                <p>{t('admin.groups.deleteBody', { name: g.name })}</p>
                {error && <InlineError>{error}</InlineError>}
              </Dialog>
            )}
          </div>
        )}
      </QueryState>
    </section>
  );
}
