import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18next } from '../i18n';
import { useQuery } from '@tanstack/react-query';
import { api, type ConflictAction, type SyncConflict } from '../app/api';
import { useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { errorCodeOf, errorMessage } from '../util/errors';
import { diffLines, hasChanges } from './diff';

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/, '');

/** One conflict: the server version and the version saved from this device side by side (remounted per conflict). */
function ConflictDetail({ vaultId, conflict }: { vaultId: string; conflict: SyncConflict }) {
  const { t } = useTranslation();
  const [merge, setMerge] = useState<string | null>(null);
  // The text being merged when the file changed under it: offered again by "Merge by hand".
  const [draft, setDraft] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reading the texts also tells the core which version of the file the user is shown: "Keep mine"
  // and a merge replace the file only while it still holds that version.
  const {
    data: texts,
    error: textsError,
    refetch,
  } = useQuery({
    queryKey: ['conflict-texts', vaultId, conflict.id],
    queryFn: () => api.sync.conflictTexts(vaultId, conflict.id),
    retry: false,
  });
  const diff = useMemo(() => (texts ? diffLines(texts.current, texts.ours) : []), [texts]);
  // "Keep mine" and a merge need the version of the file the core will compare with.
  const unread = !texts || textsError !== null;

  const resolve = async (action: ConflictAction, merged = '') => {
    setBusy(true);
    setChanged(false);
    try {
      await api.sync.resolveConflict(vaultId, conflict.id, action, merged);
      await useSync.getState().refreshConflicts(vaultId);
      void useSync.getState().refresh(vaultId);
    } catch (e) {
      if (errorCodeOf(e) !== 'conflict') {
        await dialog.error(e);
        return;
      }
      // The file changed since its version was shown (edited, synced, moved): nothing was written.
      // Show the new version, keep what was being merged, and let the user choose again.
      if (action === 'merged') setDraft(merged);
      setMerge(null);
      setChanged(true);
      await refetch();
      void useSync.getState().refreshConflicts(vaultId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conflict-detail">
      <p className="muted small">
        {t('sync.conflictExplain', { path: conflict.path, copy: conflict.copyPath })}
      </p>
      {changed && (
        <div className="warning small" role="alert">
          {t('sync.conflictChanged')}
        </div>
      )}
      {textsError && (
        <div className="error small" role="alert">
          {errorMessage(textsError)}
        </div>
      )}
      {merge === null ? (
        <div className="diff" aria-label={t('sync.sideBySide')}>
          <div className="diff-head">
            <span>{t('sync.currentVersion')}</span>
            <span>{t('sync.yourVersion')}</span>
          </div>
          {texts && !hasChanges(diff) && <div className="muted pad">{t('sync.identical')}</div>}
          {diff.map((l, i) => (
            <div key={i} className={`diff-row ${l.kind}`}>
              <pre className="old">{l.kind !== 'add' ? l.text : ''}</pre>
              <pre className="new">{l.kind !== 'del' ? l.text : ''}</pre>
            </div>
          ))}
        </div>
      ) : (
        <textarea
          className="merge"
          aria-label={t('sync.mergedText')}
          value={merge}
          onChange={(e) => setMerge(e.target.value)}
        />
      )}
      <div className="actions">
        {merge === null ? (
          <>
            <button disabled={busy} onClick={() => void resolve('keep-remote')}>
              {t('sync.keepCurrent')}
            </button>
            <button disabled={busy || unread} onClick={() => void resolve('keep-local')}>
              {t('sync.keepMine')}
            </button>
            <button disabled={busy} onClick={() => void resolve('keep-both')}>
              {t('sync.keepBoth')}
            </button>
            <button
              disabled={busy || unread}
              onClick={() => setMerge(draft ?? texts?.current ?? '')}
            >
              {t('sync.mergeManually')}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setMerge(null)}>{t('sync.back')}</button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void resolve('merged', merge)}
            >
              {t('sync.saveMerged')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Conflict resolution view (§2.9, M2-WP8). */
export function ConflictsView({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const list = useSync((s) => s.conflicts[vaultId]) ?? [];
  const [selected, setSelected] = useState<number | null>(null);
  const close = () => useSync.getState().setConflictsOpen(false);
  const current = list.find((c) => c.id === selected) ?? list[0];

  return (
    <div className="modal-backdrop" onMouseDown={close} role="presentation">
      <div
        className="modal conflicts"
        role="dialog"
        aria-modal="true"
        aria-label={t('sync.conflictsTitle')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>{t('sync.conflictsTitle')}</h2>
        {list.length === 0 ? (
          <p className="muted">{t('sync.noConflicts')}</p>
        ) : (
          <div className="conflict-layout">
            <ul className="conflict-list" role="listbox" aria-label={t('sync.conflictsTitle')}>
              {list.map((c) => (
                <li
                  key={c.id}
                  role="option"
                  aria-selected={c.id === current?.id}
                  className={c.id === current?.id ? 'active' : ''}
                  onClick={() => setSelected(c.id)}
                >
                  <strong>{base(c.path)}</strong>
                  <span className="muted small">
                    {new Date(c.createdAt).toLocaleString(i18next.language)}
                  </span>
                </li>
              ))}
            </ul>
            {current && <ConflictDetail key={current.id} vaultId={vaultId} conflict={current} />}
          </div>
        )}
        <div className="actions">
          <button onClick={close}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
