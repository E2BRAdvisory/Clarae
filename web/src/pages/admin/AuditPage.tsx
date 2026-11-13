import { Fragment, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, InlineError, Table, TextField, useToast } from '@clarae/ui';
import {
  fetchAuditCsv,
  useAdminUsers,
  useAuditLog,
  type AuditEntry,
  type AuditFilters,
} from '../../api/admin';
import { useApi } from '../../api/context';
import { downloadBlob } from '../../export/download';
import { formatDate } from '../../format';
import { QueryState } from '../QueryState';
import { adminError } from './adminError';

const EMPTY: AuditFilters = { actor: '', action: '', target: '', from: '', to: '' };

/** datetime-local value (local time, no zone) to the RFC 3339 instant the API expects. */
export function toInstant(local: string): string {
  if (local === '') return '';
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function ActorPicker({
  actor,
  actorName,
  onPick,
}: {
  actor: string;
  actorName: string;
  onPick: (id: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const users = useAdminUsers(
    { q, status: '', role: '', group: '', sort: 'name', limit: 8, offset: 0 },
    q !== '',
  );
  return (
    <fieldset className="admin-fieldset">
      <legend>{t('admin.audit.actor')}</legend>
      {actor ? (
        <p className="nd-row">
          <span>{actorName}</span>
          <Button small onClick={() => onPick('', '')}>
            {t('admin.audit.clearActor')}
          </Button>
        </p>
      ) : (
        <>
          <div className="nd-row">
            <TextField
              label={t('admin.audit.actorSearch')}
              type="search"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setQ(input.trim());
                }
              }}
            />
            <Button onClick={() => setQ(input.trim())} disabled={input.trim() === ''}>
              {t('shares.search')}
            </Button>
          </div>
          {q !== '' && users.data && (
            <ul aria-label={t('admin.audit.actorResults')}>
              {users.data.items.length === 0 && (
                <li className="nd-muted">{t('shares.noResults')}</li>
              )}
              {users.data.items.map((u) => (
                <li key={u.id}>
                  <Button
                    small
                    aria-label={t('admin.audit.pickActor', { name: u.username })}
                    onClick={() => onPick(u.id, u.display_name || u.username)}
                  >
                    {u.display_name || u.username}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </fieldset>
  );
}

function Row({ entry }: { entry: AuditEntry }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasDetails = entry.details && Object.keys(entry.details).length > 0;
  return (
    <Fragment>
      <tr>
        <td>{formatDate(entry.at, i18n.language)}</td>
        <td>{entry.actor_name || entry.actor_id || '—'}</td>
        <td>
          <code>{entry.action}</code>
        </td>
        <td>
          {entry.target_type ? `${entry.target_type}: ` : ''}
          {entry.target_id ?? ''}
        </td>
        <td>{entry.ip ?? ''}</td>
        <td>
          {hasDetails && (
            <Button
              small
              aria-expanded={open}
              aria-label={t(open ? 'admin.audit.hideDetails' : 'admin.audit.showDetails', {
                action: entry.action,
              })}
              onClick={() => setOpen((o) => !o)}
            >
              {t('admin.audit.details')}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6}>
            <pre className="admin-json" tabIndex={0}>
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function AuditPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const api = useApi();
  const [draft, setDraft] = useState({ ...EMPTY });
  const [actorName, setActorName] = useState('');
  const [applied, setApplied] = useState<AuditFilters>({ ...EMPTY });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const log = useAuditLog(applied);

  const set = (patch: Partial<AuditFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const apply = (e: FormEvent) => {
    e.preventDefault();
    setApplied({
      actor: draft.actor,
      action: draft.action.trim(),
      target: draft.target.trim(),
      from: toInstant(draft.from),
      to: toInstant(draft.to),
    });
  };

  const exportCsv = () => {
    setExporting(true);
    setExportError(null);
    fetchAuditCsv(api, applied)
      .then((blob) => {
        downloadBlob(blob, 'audit-log.csv');
        toast.push(t('admin.audit.exportedToast'));
      })
      .catch((err: unknown) => setExportError(adminError(err, t)))
      .finally(() => setExporting(false));
  };

  return (
    <section aria-labelledby="admin-audit">
      <div className="nd-row admin-head">
        <h2 id="admin-audit">{t('admin.sections.audit')}</h2>
        <Button onClick={exportCsv} disabled={exporting}>
          {t('admin.audit.exportCsv')}
        </Button>
      </div>
      <p role="status" className="nd-visually-hidden">
        {exporting ? t('admin.audit.exporting') : ''}
      </p>
      {exportError && <InlineError>{exportError}</InlineError>}

      <form className="nd-stack" aria-label={t('admin.audit.filters')} onSubmit={apply}>
        <div className="nd-row">
          <ActorPicker
            actor={draft.actor}
            actorName={actorName}
            onPick={(id, name) => {
              set({ actor: id });
              setActorName(name);
            }}
          />
          <TextField
            label={t('admin.audit.action')}
            hint={t('admin.audit.actionHint')}
            value={draft.action}
            onChange={(e) => set({ action: e.target.value })}
          />
          <TextField
            label={t('admin.audit.target')}
            value={draft.target}
            onChange={(e) => set({ target: e.target.value })}
          />
          <TextField
            label={t('admin.audit.from')}
            type="datetime-local"
            value={draft.from}
            onChange={(e) => set({ from: e.target.value })}
          />
          <TextField
            label={t('admin.audit.to')}
            type="datetime-local"
            value={draft.to}
            onChange={(e) => set({ to: e.target.value })}
          />
        </div>
        <div className="nd-row">
          <Button type="submit" variant="primary">
            {t('admin.audit.apply')}
          </Button>
          <Button
            onClick={() => {
              setDraft({ ...EMPTY });
              setActorName('');
              setApplied({ ...EMPTY });
            }}
          >
            {t('admin.audit.reset')}
          </Button>
        </div>
      </form>

      <QueryState query={log}>
        {() => {
          const entries = (log.data?.pages ?? []).flatMap((p) => p.items);
          if (entries.length === 0) return <p className="nd-muted">{t('admin.audit.empty')}</p>;
          return (
            <div className="nd-stack">
              <Table caption={t('admin.sections.audit')}>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.audit.colTime')}</th>
                    <th scope="col">{t('admin.audit.actor')}</th>
                    <th scope="col">{t('admin.audit.action')}</th>
                    <th scope="col">{t('admin.audit.target')}</th>
                    <th scope="col">{t('admin.audit.colIp')}</th>
                    <th scope="col">
                      <span className="nd-visually-hidden">{t('admin.audit.details')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <Row key={e.id} entry={e} />
                  ))}
                </tbody>
              </Table>
              {log.hasNextPage && (
                <Button disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                  {t('admin.audit.loadMore')}
                </Button>
              )}
            </div>
          );
        }}
      </QueryState>
    </section>
  );
}
