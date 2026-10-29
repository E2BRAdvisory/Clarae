import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RevisionInfo } from '../app/api';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { diffLines } from '../sync/diff';
import { useRecovery } from './store';
import { mergeVersions, type Version } from './versions';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Text of a version (local snapshot or cloud revision). */
async function versionText(vaultId: string, path: string, v: Version): Promise<string> {
  if (v.source === 'local') return (await api.history.read(vaultId, v.snapshot.id)).content;
  return api.sync.revisionText(vaultId, path, v.revision.rev);
}

/** Diff of one version against the current text (remounted when another version is picked). */
function VersionDiff({
  vaultId,
  path,
  version,
  current,
}: {
  vaultId: string;
  path: string;
  version: Version;
  current: string;
}) {
  const { t } = useTranslation();
  const { data: text, error } = useQuery({
    queryKey: ['recovery-text', vaultId, path, version.key],
    queryFn: () => versionText(vaultId, path, version),
  });
  const diff = useMemo(() => (text === undefined ? [] : diffLines(text, current)), [text, current]);
  return (
    <div className="diff" aria-label={t('recovery.diffAgainstCurrent')}>
      <div className="diff-head">
        <span>{t('recovery.selectedVersion')}</span>
        <span>{t('recovery.currentText')}</span>
      </div>
      {error && (
        <div className="error pad" role="alert">
          {msg(error)}
        </div>
      )}
      {text !== undefined && diff.every((l) => l.kind === 'same') && (
        <div className="muted pad">{t('recovery.identical')}</div>
      )}
      {diff.map((l, i) => (
        <div key={i} className={`diff-row ${l.kind}`}>
          <pre className="old">{l.kind !== 'add' ? l.text : ''}</pre>
          <pre className="new">{l.kind !== 'del' ? l.text : ''}</pre>
        </div>
      ))}
    </div>
  );
}

function useFormat(): (iso: string) => string {
  const language = useAppStore((s) => s.settings.language);
  return (iso) => new Date(iso).toLocaleString(language || undefined);
}

/** Local snapshots and cloud revisions of one note in a single list, with diff and restore. */
function NoteRecovery({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fmt = useFormat();
  const info = useSync((s) => infoOf(s, vaultId));
  const cloudOn = info.linked && !info.locked;
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useRecovery.getState().close();

  const current = useQuery({
    queryKey: ['recovery-current', vaultId, path],
    // A deleted note has no current text: everything differs from it.
    queryFn: () =>
      api.vault.readNote(vaultId, path).then(
        (n) => n.content,
        () => '',
      ),
  });
  const local = useQuery({
    queryKey: ['recovery-local', vaultId, path],
    queryFn: () => api.history.list(vaultId, path),
  });
  const cloud = useQuery({
    queryKey: ['recovery-cloud', vaultId, path],
    queryFn: () => api.sync.history(vaultId, path),
    enabled: cloudOn,
    retry: false,
  });

  const versions = useMemo(
    () => mergeVersions(local.data ?? [], cloudOn ? (cloud.data ?? ([] as RevisionInfo[])) : []),
    [local.data, cloud.data, cloudOn],
  );
  const selected = versions.find((v) => v.key === picked) ?? versions[0];
  const loaded = local.data !== undefined && current.data !== undefined;

  const label = (v: Version): string =>
    v.source === 'local'
      ? t(`recovery.reason_${v.snapshot.reason.replace(/-/g, '_')}`, {
          defaultValue: v.snapshot.reason,
        })
      : t('recovery.revisionN', { n: v.revision.rev });

  const restore = async () => {
    if (!selected) return;
    const ok = await dialog.confirm(
      t('recovery.restoreTitle'),
      t('recovery.restoreText', {
        when: fmt(selected.time),
        source: t(`recovery.source_${selected.source}`),
      }),
    );
    if (!ok) return;
    setBusy(true);
    try {
      if (selected.source === 'local') await api.history.restore(vaultId, selected.snapshot.id);
      else await api.sync.restoreRevision(vaultId, path, selected.revision.rev);
      await qc.invalidateQueries({ queryKey: ['recovery-local', vaultId, path] });
      close();
    } catch (e) {
      await dialog.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal history"
      role="dialog"
      aria-modal="true"
      aria-label={t('recovery.title')}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <h2>
        {t('recovery.title')} · {path.replace(/\.md$/, '')}
      </h2>
      {local.error && (
        <div className="error" role="alert">
          {msg(local.error)}
        </div>
      )}
      {cloudOn && cloud.error && (
        <div className="muted small" role="status">
          {t('recovery.cloudUnavailable', { error: msg(cloud.error) })}
        </div>
      )}
      {info.readOnly && <p className="muted small">{t('recovery.readOnly')}</p>}
      {loaded && versions.length === 0 && <p className="muted">{t('recovery.noVersions')}</p>}
      {loaded && versions.length > 0 && selected && (
        <div className="history-layout">
          <ul className="revision-list" role="listbox" aria-label={t('recovery.title')}>
            {versions.map((v) => (
              <li
                key={v.key}
                role="option"
                aria-selected={v.key === selected.key}
                className={v.key === selected.key ? 'active' : ''}
                onClick={() => setPicked(v.key)}
              >
                <strong>
                  {label(v)}
                  <span className={`badge source-${v.source}`}>
                    {t(`recovery.source_${v.source}`)}
                  </span>
                </strong>
                <span className="muted small">{fmt(v.time)}</span>
              </li>
            ))}
          </ul>
          <VersionDiff
            key={selected.key}
            vaultId={vaultId}
            path={path}
            version={selected}
            current={current.data ?? ''}
          />
        </div>
      )}
      <div className="actions">
        <button onClick={close}>{t('settings.close')}</button>
        <button
          className="primary"
          disabled={busy || !selected || info.readOnly}
          onClick={() => void restore()}
        >
          {t('recovery.restore')}
        </button>
      </div>
    </div>
  );
}

/** Files that no longer exist but have snapshots: restore the newest one or browse its versions. */
function DeletedRecovery({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const readOnly = useSync((s) => infoOf(s, vaultId).readOnly);
  const [busy, setBusy] = useState(false);
  const { data, error, refetch } = useQuery({
    queryKey: ['recovery-deleted', vaultId],
    queryFn: () => api.history.listDeleted(vaultId),
  });
  const restore = async (snapshotId: string) => {
    setBusy(true);
    try {
      await api.history.restore(vaultId, snapshotId);
      await refetch();
    } catch (e) {
      await dialog.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="modal history"
      role="dialog"
      aria-modal="true"
      aria-label={t('recovery.deletedTitle')}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <h2>{t('recovery.deletedTitle')}</h2>
      {error && (
        <div className="error" role="alert">
          {msg(error)}
        </div>
      )}
      {data && data.length === 0 && <p className="muted">{t('recovery.deletedEmpty')}</p>}
      {data && data.length > 0 && (
        <ul className="revision-list deleted-list" aria-label={t('recovery.deletedTitle')}>
          {data.map((d) => (
            <li key={d.path}>
              <strong>{d.path}</strong>
              <span className="muted small">{t('recovery.lastSaved', { when: fmt(d.time) })}</span>
              <span className="actions left">
                <button onClick={() => useRecovery.getState().openNote(d.path)}>
                  {t('recovery.versions')}
                </button>
                <button
                  className="primary"
                  disabled={busy || readOnly}
                  onClick={() => void restore(d.snapshotId)}
                >
                  {t('recovery.restoreFile')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button onClick={() => useRecovery.getState().close()}>{t('settings.close')}</button>
      </div>
    </div>
  );
}

/** Hosts the File recovery dialog of the open vault. */
export function RecoveryDialogs() {
  const vault = useAppStore((s) => s.vault);
  const target = useRecovery((s) => s.target);
  if (!vault || !target) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => useRecovery.getState().close()}
      role="presentation"
    >
      {target.kind === 'note' ? (
        <NoteRecovery key={target.path} vaultId={vault.id} path={target.path} />
      ) : (
        <DeletedRecovery vaultId={vault.id} />
      )}
    </div>
  );
}
