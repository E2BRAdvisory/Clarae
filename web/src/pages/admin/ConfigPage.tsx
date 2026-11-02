import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@memobrain/api-client';
import { Badge, Button, Card, Dialog, InlineError, TextField, useToast } from '@memobrain/ui';
import {
  useDeleteProfile,
  useProfile,
  useProfiles,
  useProfileVersions,
  useRestoreVersion,
  useSaveProfile,
  type ConfigProfile,
  type ProfileVersion,
} from '../../api/admin';
import { formatDate } from '../../format';
import { QueryState } from '../QueryState';
import { adminError } from './adminError';
import configSchema from '../../../../api/config-profile.schema.json';

/** Top-level keys the profile schema allows (api/config-profile.schema.json). */
export const SCHEMA_KEYS: string[] = Object.keys(
  (configSchema as { properties: Record<string, unknown> }).properties,
);

export type ConfigIssue =
  { kind: 'syntax'; message: string } | { kind: 'notObject' } | { kind: 'unknownKey'; key: string };

/** Live check of the config JSON: syntax, object at the root, known top-level keys. */
export function checkConfigText(text: string): {
  value?: Record<string, unknown>;
  issues: ConfigIssue[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      issues: [{ kind: 'syntax', message: err instanceof Error ? err.message : String(err) }],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { issues: [{ kind: 'notObject' }] };
  const value = parsed as Record<string, unknown>;
  const issues: ConfigIssue[] = Object.keys(value)
    .filter((k) => !SCHEMA_KEYS.includes(k))
    .map((key) => ({ kind: 'unknownKey', key }));
  return issues.length > 0 ? { issues } : { value, issues };
}

/** Locked keys are dotted paths starting with a top-level key of the schema. */
export function checkLockedKeys(keys: string[]): string[] {
  return keys.filter(
    (k) =>
      !/^[A-Za-z_][\w-]*(\.[\w-]+)*$/.test(k) || !SCHEMA_KEYS.includes(k.split('.')[0] as string),
  );
}

const parseKeys = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

/* ---- List ------------------------------------------------------------------------------------ */

export function ConfigListPage() {
  const { t, i18n } = useTranslation();
  const profiles = useProfiles();
  return (
    <section aria-labelledby="admin-config">
      <div className="nd-row admin-head">
        <h2 id="admin-config">{t('admin.sections.config')}</h2>
        <Link className="nd-button nd-button--primary" to="/admin/config/new">
          {t('admin.config.create')}
        </Link>
      </div>
      <p className="nd-muted">{t('admin.config.note')}</p>
      <QueryState query={profiles}>
        {(list) => {
          if (list.length === 0) return <p className="nd-muted">{t('admin.config.empty')}</p>;
          const sorted = [...list].sort(
            (a, b) => Number(b.is_global) - Number(a.is_global) || a.name.localeCompare(b.name),
          );
          return (
            <ul className="admin-list">
              {sorted.map((p) => (
                <li key={p.id} className="nd-card">
                  <div className="nd-row">
                    <Link to={`/admin/config/${p.id}`}>
                      <strong>{p.name}</strong>
                    </Link>
                    {p.is_global && <Badge tone="warn">{t('admin.config.global')}</Badge>}
                    <Badge>{t('admin.config.version', { version: p.version })}</Badge>
                  </div>
                  {p.description && <p>{p.description}</p>}
                  <p className="nd-muted">
                    {t('admin.config.updated', { date: formatDate(p.updated_at, i18n.language) })}
                  </p>
                </li>
              ))}
            </ul>
          );
        }}
      </QueryState>
    </section>
  );
}

/* ---- Editor ------------------------------------------------------------------------------------- */

const EMPTY: ConfigProfile = {
  id: '',
  name: '',
  is_global: false,
  version: 0,
  config: {},
  locked_keys: [],
  updated_at: '',
};

/** The editor's fields for a profile, as they are shown before any edit. */
function fieldsOf(p: ConfigProfile) {
  return {
    name: p.name,
    description: p.description ?? '',
    isGlobal: p.is_global,
    configText: JSON.stringify(p.config, null, 2),
    lockedText: p.locked_keys.join('\n'),
  };
}

function Editor({
  profile,
  existingGlobal,
  reload,
}: {
  profile: ConfigProfile;
  existingGlobal?: ConfigProfile;
  /** Reads the profile again from the server (after a conflict). */
  reload?: () => Promise<ConfigProfile | undefined>;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const save = useSaveProfile();
  const del = useDeleteProfile();
  const isNew = profile.id === '';
  // The version the fields were loaded from: a save applies only to it (expected_version), so a
  // change another administrator saved meanwhile is never overwritten silently.
  const [base, setBase] = useState(() => ({ version: profile.version, fields: fieldsOf(profile) }));
  const [name, setName] = useState(base.fields.name);
  const [description, setDescription] = useState(base.fields.description);
  const [isGlobal, setIsGlobal] = useState(base.fields.isGlobal);
  const [configText, setConfigText] = useState(base.fields.configText);
  const [lockedText, setLockedText] = useState(base.fields.lockedText);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmGlobal, setConfirmGlobal] = useState(false);
  const [seenVersion, setSeenVersion] = useState(profile.version);

  const dirty =
    name !== base.fields.name ||
    description !== base.fields.description ||
    isGlobal !== base.fields.isGlobal ||
    configText !== base.fields.configText ||
    lockedText !== base.fields.lockedText;

  const loadFrom = (p: ConfigProfile) => {
    const f = fieldsOf(p);
    setBase({ version: p.version, fields: f });
    setSeenVersion(p.version);
    setName(f.name);
    setDescription(f.description);
    setIsGlobal(f.isGlobal);
    setConfigText(f.configText);
    setLockedText(f.lockedText);
    setError(null);
  };

  // Another version arrived (a restore from the history, another administrator's save): an editor
  // without edits shows it, one with edits keeps them and says that a newer version exists. While
  // a save is pending the version that arrives is its own (loaded when the save answers).
  if (!isNew && profile.version !== seenVersion && !save.isPending) {
    setSeenVersion(profile.version);
    if (!dirty && profile.version !== base.version) loadFrom(profile);
  }
  const newer = !isNew && profile.version > base.version ? profile.version : null;

  const reloadLatest = () => {
    void (reload ? reload() : Promise.resolve(profile)).then((p) => p && loadFrom(p));
  };

  const check = useMemo(() => checkConfigText(configText), [configText]);
  const locked = useMemo(() => parseKeys(lockedText), [lockedText]);
  const badLocked = useMemo(() => checkLockedKeys(locked), [locked]);
  const replacesGlobal =
    isGlobal && existingGlobal !== undefined && existingGlobal.id !== profile.id;
  const valid = name.trim() !== '' && check.value !== undefined && badLocked.length === 0;

  const doSave = () => {
    if (!check.value) return;
    setError(null);
    save.mutate(
      {
        ...(isNew ? {} : { id: profile.id }),
        body: {
          name: name.trim(),
          description: description.trim(),
          is_global: isGlobal,
          config: check.value,
          locked_keys: locked,
          ...(isNew ? {} : { expected_version: base.version }),
        },
      },
      {
        onSuccess: (saved) => {
          toast.push(t('admin.config.savedToast', { version: saved.version }));
          setConfirmGlobal(false);
          if (isNew) void navigate(`/admin/config/${saved.id}`, { replace: true });
          else loadFrom(saved);
        },
        onError: (err) => {
          setConfirmGlobal(false);
          if (err instanceof ApiError && err.code === 'REV_CONFLICT') {
            // Another administrator saved meanwhile: the edits stay, the newer version is read so
            // the editor can offer it.
            setError(t('admin.config.conflict'));
            void reload?.();
            return;
          }
          setError(adminError(err, t));
        },
      },
    );
  };

  return (
    <div className="nd-stack">
      <Card>
        <form
          className="nd-stack"
          noValidate
          aria-label={t('admin.config.editor')}
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            if (replacesGlobal) setConfirmGlobal(true);
            else doSave();
          }}
        >
          <TextField
            label={t('admin.config.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label={t('admin.config.description')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <label className="admin-radio">
            <input
              type="checkbox"
              checked={isGlobal}
              onChange={(e) => setIsGlobal(e.target.checked)}
            />{' '}
            {t('admin.config.isGlobal')}
          </label>
          <p className="nd-muted">{t('admin.config.isGlobalHint')}</p>
          {replacesGlobal && (
            <p role="status" className="admin-warning">
              {t('admin.config.replacesGlobal', { name: existingGlobal.name })}
            </p>
          )}

          <div className="nd-field">
            <label className="nd-field__label" htmlFor="config-json">
              {t('admin.config.json')}
            </label>
            <textarea
              id="config-json"
              className="nd-input admin-editor"
              rows={14}
              spellCheck={false}
              aria-invalid={check.value === undefined}
              aria-describedby="config-json-status"
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
            />
            <div id="config-json-status" aria-live="polite">
              {check.value ? (
                <span className="admin-ok">{t('admin.config.jsonValid')}</span>
              ) : (
                <ul className="admin-errors">
                  {check.issues.map((i) => (
                    <li key={i.kind === 'unknownKey' ? i.key : i.kind}>
                      {i.kind === 'syntax' && t('admin.config.jsonSyntax', { message: i.message })}
                      {i.kind === 'notObject' && t('admin.config.jsonNotObject')}
                      {i.kind === 'unknownKey' && t('admin.config.jsonUnknownKey', { key: i.key })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <span className="nd-field__hint">
              {t('admin.config.jsonHint', { keys: SCHEMA_KEYS.join(', ') })}
            </span>
          </div>

          <div className="nd-field">
            <label className="nd-field__label" htmlFor="config-locked">
              {t('admin.config.locked')}
            </label>
            <textarea
              id="config-locked"
              className="nd-input admin-editor admin-editor--small"
              rows={4}
              spellCheck={false}
              aria-invalid={badLocked.length > 0}
              aria-describedby="config-locked-status"
              value={lockedText}
              onChange={(e) => setLockedText(e.target.value)}
            />
            <div id="config-locked-status" aria-live="polite">
              {badLocked.length > 0 && (
                <span className="admin-errors">
                  {t('admin.config.lockedInvalid', { keys: badLocked.join(', ') })}
                </span>
              )}
            </div>
            <span className="nd-field__hint">{t('admin.config.lockedHint')}</span>
          </div>

          {!isNew && (
            <p className="nd-muted">
              {t('admin.config.version', { version: base.version })} ·{' '}
              {t('admin.config.updated', { date: formatDate(profile.updated_at, i18n.language) })}
            </p>
          )}
          {newer !== null && (
            <div role="alert" className="admin-warning nd-stack">
              <p>{t('admin.config.newerVersion', { version: newer })}</p>
              <div>
                <Button small onClick={reloadLatest}>
                  {t('admin.config.reload')}
                </Button>
              </div>
            </div>
          )}
          {error && <InlineError>{error}</InlineError>}
          <div className="nd-row">
            <Button type="submit" variant="primary" disabled={!valid || save.isPending}>
              {t('admin.config.save')}
            </Button>
            {!isNew && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                {t('admin.config.delete')}
              </Button>
            )}
          </div>
        </form>
      </Card>

      {!isNew && <History profile={profile} />}

      {confirmGlobal && existingGlobal && (
        <Dialog
          title={t('admin.config.globalTitle')}
          onClose={() => setConfirmGlobal(false)}
          actions={
            <>
              <Button onClick={() => setConfirmGlobal(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={save.isPending} onClick={doSave}>
                {t('admin.config.globalConfirm')}
              </Button>
            </>
          }
        >
          <p>{t('admin.config.globalBody', { name: existingGlobal.name })}</p>
        </Dialog>
      )}
      {confirmDelete && (
        <Dialog
          title={t('admin.config.deleteTitle')}
          onClose={() => setConfirmDelete(false)}
          actions={
            <>
              <Button onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                disabled={del.isPending}
                onClick={() =>
                  del.mutate(profile.id, {
                    onSuccess: () => {
                      toast.push(t('admin.config.deletedToast'));
                      void navigate('/admin/config');
                    },
                    onError: (err) => {
                      setConfirmDelete(false);
                      setError(adminError(err, t));
                    },
                  })
                }
              >
                {t('admin.config.delete')}
              </Button>
            </>
          }
        >
          <p>{t('admin.config.deleteBody', { name: profile.name })}</p>
        </Dialog>
      )}
    </div>
  );
}

/* ---- History ------------------------------------------------------------------------------------------ */

function History({ profile }: { profile: ConfigProfile }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const versions = useProfileVersions(profile.id);
  const restore = useRestoreVersion(profile.id);
  const [selected, setSelected] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ProfileVersion | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-labelledby="cfg-history">
      <h3 id="cfg-history">{t('admin.config.history')}</h3>
      {error && <InlineError>{error}</InlineError>}
      <QueryState query={versions}>
        {(list) => {
          const sorted = [...list].sort((a, b) => b.version - a.version);
          const sel = sorted.find((v) => v.version === selected);
          return (
            <div className="nd-stack">
              <ul className="admin-list" aria-label={t('admin.config.history')}>
                {sorted.map((v) => (
                  <li key={v.version} className="nd-row">
                    <span>
                      <strong>{t('admin.config.version', { version: v.version })}</strong>{' '}
                      {v.version === profile.version && (
                        <Badge tone="ok">{t('admin.config.current')}</Badge>
                      )}
                      <span className="nd-muted">
                        {' '}
                        · {formatDate(v.updated_at, i18n.language)}
                        {v.updated_by
                          ? ` · ${t('admin.config.by', { id: v.updated_by.slice(0, 8) })}`
                          : ''}
                      </span>
                    </span>
                    <Button
                      small
                      aria-pressed={selected === v.version}
                      aria-label={t('admin.config.compareAria', { version: v.version })}
                      onClick={() => setSelected(selected === v.version ? null : v.version)}
                    >
                      {t('admin.config.compare')}
                    </Button>
                    {v.version !== profile.version && (
                      <Button
                        small
                        aria-label={t('admin.config.restoreAria', { version: v.version })}
                        onClick={() => {
                          setError(null);
                          setConfirm(v);
                        }}
                      >
                        {t('admin.config.restore')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {sel && (
                <div className="admin-diff" role="group" aria-label={t('admin.config.diff')}>
                  <div>
                    <h4>{t('admin.config.version', { version: sel.version })}</h4>
                    <pre className="admin-json" tabIndex={0}>
                      {JSON.stringify(
                        { config: sel.config, locked_keys: sel.locked_keys },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                  <div>
                    <h4>{t('admin.config.currentVersion', { version: profile.version })}</h4>
                    <pre className="admin-json" tabIndex={0}>
                      {JSON.stringify(
                        { config: profile.config, locked_keys: profile.locked_keys },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          );
        }}
      </QueryState>
      {confirm && (
        <Dialog
          title={t('admin.config.restoreTitle', { version: confirm.version })}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate(confirm.version, {
                    onSuccess: (p) => {
                      toast.push(t('admin.config.restoredToast', { version: p.version }));
                      setConfirm(null);
                      setSelected(null);
                    },
                    onError: (err) => {
                      setConfirm(null);
                      setError(adminError(err, t));
                    },
                  })
                }
              >
                {t('admin.config.restore')}
              </Button>
            </>
          }
        >
          <p>{t('admin.config.restoreBody', { version: confirm.version })}</p>
        </Dialog>
      )}
    </section>
  );
}

/* ---- Detail page ---------------------------------------------------------------------------------------- */

export function ConfigDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const isNew = id === 'new';
  const profiles = useProfiles();
  const profile = useProfile(isNew ? '' : id);
  const existingGlobal = profiles.data?.find((p) => p.is_global);
  return (
    <section aria-labelledby="admin-profile">
      <p>
        <Link to="/admin/config">{t('admin.config.back')}</Link>
      </p>
      {isNew ? (
        <>
          <h2 id="admin-profile">{t('admin.config.createTitle')}</h2>
          <Editor key="new" profile={EMPTY} {...(existingGlobal ? { existingGlobal } : {})} />
        </>
      ) : (
        <QueryState query={profile}>
          {(p) => (
            <>
              <h2 id="admin-profile">{p.name}</h2>
              <Editor
                key={p.id}
                profile={p}
                reload={() => profile.refetch().then((r) => r.data)}
                {...(existingGlobal ? { existingGlobal } : {})}
              />
            </>
          )}
        </QueryState>
      )}
    </section>
  );
}
