import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineError, SelectField, Table, TextField } from '@memobrain/ui';
import { cloudKeys, describeError } from '../CloudVaultsTable';
import type { TFunction } from '../i18n';
import type {
  CloudPort,
  DirectoryEntry,
  Grant,
  GrantStatus,
  PrincipalType,
  Share,
  SharePermission,
} from '../port';

export const PERMISSIONS: SharePermission[] = ['viewer', 'editor', 'manager'];

export function permissionLabel(t: TFunction, p: SharePermission): string {
  return t(`grants.permission_${p}`);
}

export function statusTone(s: GrantStatus): 'ok' | 'warn' | 'neutral' {
  return s === 'accepted' ? 'ok' : s === 'pending' ? 'warn' : 'neutral';
}

const keyOf = (type: PrincipalType, id: string) => `${type}:${id}`;

export interface DirectorySearchProps {
  port: CloudPort;
  t: TFunction;
  /** Principals already in the list ("user:id", "group:id"): shown, but they cannot be added. */
  exclude: Set<string>;
  busy?: boolean | undefined;
  /** Called with the entry picked and the permission chosen next to the search. */
  onPick: (entry: DirectoryEntry, permission: SharePermission) => void;
  /** The permission preselected for the next principal (default viewer). */
  defaultPermission?: SharePermission | undefined;
}

/**
 * Search of the directory (users or groups, at least two characters) with the permission to give:
 * the "add people" form of every share editor, and of the hosts' own share creation.
 */
export function DirectorySearch({
  port,
  t,
  exclude,
  busy,
  onPick,
  defaultPermission = 'viewer',
}: DirectorySearchProps) {
  const [type, setType] = useState<PrincipalType>('user');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [permission, setPermission] = useState<SharePermission>(defaultPermission);
  const results = useQuery({
    queryKey: cloudKeys.directory(port, type, query),
    queryFn: () => port.searchDirectory(type, query),
    enabled: query.length >= 2,
    staleTime: 10_000,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setQuery(input.trim());
  };

  return (
    <form className="mbcf-search" onSubmit={submit} aria-label={t('grants.add')}>
      <h4>{t('grants.add')}</h4>
      <div className="mbcf-fields">
        <SelectField
          label={t('grants.addType')}
          value={type}
          onChange={(e) => {
            setType(e.target.value as PrincipalType);
            setQuery('');
          }}
        >
          <option value="user">{t('grants.user')}</option>
          <option value="group">{t('grants.group')}</option>
        </SelectField>
        <TextField
          label={t('grants.searchLabel')}
          hint={t('grants.searchHint')}
          type="search"
          value={input}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
        />
        <SelectField
          label={t('grants.newPermission')}
          value={permission}
          onChange={(e) => setPermission(e.target.value as SharePermission)}
        >
          {PERMISSIONS.map((p) => (
            <option key={p} value={p}>
              {permissionLabel(t, p)}
            </option>
          ))}
        </SelectField>
        <Button type="submit" disabled={input.trim().length < 2}>
          {t('grants.search')}
        </Button>
      </div>
      {query.length >= 2 && results.isError && (
        <InlineError>{describeError(t, results.error, 'share')}</InlineError>
      )}
      {query.length >= 2 && results.data && (
        <ul className="mbcf-results" aria-label={t('grants.results')}>
          {results.data.length === 0 && <li className="mbcf-muted">{t('grants.noResults')}</li>}
          {results.data.map((r) => {
            const has = exclude.has(keyOf(r.type, r.id));
            return (
              <li key={keyOf(r.type, r.id)}>
                <span>
                  {r.name}
                  {r.detail ? <span className="mbcf-muted"> ({r.detail})</span> : null}
                </span>
                <Button
                  small
                  aria-label={t('grants.addAria', { name: r.name })}
                  title={has ? t('grants.already') : undefined}
                  disabled={busy || has}
                  onClick={() => onPick(r, permission)}
                >
                  {t('grants.addOne')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </form>
  );
}

export interface GrantEditorProps {
  port: CloudPort;
  t: TFunction;
  share: Share;
  /** Reports a change in the host's status line. */
  onStatus: (message: string) => void;
}

/** Who has access to a share and at what level, with the directory search to add more. */
export function GrantEditor({ port, t, share, onStatus }: GrantEditorProps) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const grants = share.grants ?? [];
  const granted = new Set(grants.map((g) => keyOf(g.principal_type, g.principal_id)));

  const run = async (fn: () => Promise<void>, message: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onStatus(message);
      await qc.invalidateQueries({ queryKey: cloudKeys.shares(port) });
    } catch (e) {
      setError(describeError(t, e, 'share'));
    } finally {
      setBusy(false);
    }
  };
  const put = (type: PrincipalType, id: string, name: string, permission: SharePermission) =>
    void run(() => port.putGrant(share.id, type, id, permission), t('grants.saved', { name }));
  const remove = (g: Grant) =>
    void run(
      () => port.deleteGrant(share.id, g.principal_type, g.principal_id),
      t('grants.removed', { name: g.principal_name }),
    );

  return (
    <div className="mbcf-grants">
      {error && <InlineError>{error}</InlineError>}
      {grants.length === 0 ? (
        <p className="mbcf-muted">{t('grants.none')}</p>
      ) : (
        <Table caption={t('grants.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('grants.colWho')}</th>
              <th scope="col">{t('grants.colPermission')}</th>
              <th scope="col">{t('grants.colStatus')}</th>
              <th scope="col">
                <span className="nd-visually-hidden">{t('grants.colActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={keyOf(g.principal_type, g.principal_id)}>
                <th scope="row">
                  {g.principal_name}{' '}
                  <Badge>
                    {g.principal_type === 'group' ? t('grants.group') : t('grants.user')}
                  </Badge>
                </th>
                <td>
                  <select
                    className="nd-select"
                    aria-label={t('grants.permissionOf', { name: g.principal_name })}
                    value={g.permission}
                    disabled={busy}
                    onChange={(e) =>
                      put(
                        g.principal_type,
                        g.principal_id,
                        g.principal_name,
                        e.target.value as SharePermission,
                      )
                    }
                  >
                    {PERMISSIONS.map((p) => (
                      <option key={p} value={p}>
                        {permissionLabel(t, p)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Badge tone={statusTone(g.status)}>{t(`grants.status_${g.status}`)}</Badge>
                </td>
                <td>
                  <Button
                    small
                    variant="danger"
                    aria-label={t('grants.removeAria', { name: g.principal_name })}
                    disabled={busy}
                    onClick={() => remove(g)}
                  >
                    {t('grants.remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <DirectorySearch
        port={port}
        t={t}
        exclude={granted}
        busy={busy}
        onPick={(r, permission) => put(r.type, r.id, r.name, permission)}
      />
    </div>
  );
}
