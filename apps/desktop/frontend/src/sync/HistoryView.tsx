import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type RevisionInfo } from '../app/api';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { diffLines } from './diff';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Diff of one revision against the current text (remounted when another revision is picked). */
function RevisionDiff({
  vaultId,
  path,
  rev,
  current,
}: {
  vaultId: string;
  path: string;
  rev: number;
  current: string;
}) {
  const { t } = useTranslation();
  const { data: text, error } = useQuery({
    queryKey: ['revision-text', vaultId, path, rev],
    queryFn: () => api.sync.revisionText(vaultId, path, rev),
  });
  const diff = useMemo(() => (text === undefined ? [] : diffLines(text, current)), [text, current]);
  return (
    <div className="diff" aria-label={t('sync.diffAgainstCurrent')}>
      <div className="diff-head">
        <span>{t('sync.revisionN', { n: rev })}</span>
        <span>{t('sync.currentText')}</span>
      </div>
      {error && (
        <div className="error pad" role="alert">
          {msg(error)}
        </div>
      )}
      {text !== undefined && diff.every((l) => l.kind === 'same') && (
        <div className="muted pad">{t('sync.identical')}</div>
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

/** Version history of a note: revisions, a diff against the current text, and restore. */
export function HistoryView({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const language = useAppStore((s) => s.settings.language);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useSync.getState().openHistory(null);

  const { data, error } = useQuery({
    queryKey: ['history', vaultId, path],
    queryFn: async () => {
      const [revs, note] = await Promise.all([
        api.sync.history(vaultId, path),
        api.vault.readNote(vaultId, path),
      ]);
      return { revs, current: note.content };
    },
  });
  const revs: RevisionInfo[] = data?.revs ?? [];
  const selected = picked ?? revs.find((r) => r.hasContent)?.rev ?? null;
  const fmt = (iso: string): string => new Date(iso).toLocaleString(language || undefined);

  const restore = async () => {
    if (selected === null) return;
    if (!(await dialog.confirm(t('sync.restoreTitle'), t('sync.restoreText', { rev: selected }))))
      return;
    setBusy(true);
    try {
      await api.sync.restoreRevision(vaultId, path, selected);
      close();
    } catch (e) {
      await dialog.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} role="presentation">
      <div
        className="modal history"
        role="dialog"
        aria-modal="true"
        aria-label={t('sync.historyTitle')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>
          {t('sync.historyTitle')} · {path.replace(/\.md$/, '')}
        </h2>
        {error && (
          <div className="error" role="alert">
            {msg(error)}
          </div>
        )}
        {data && revs.length === 0 && <p className="muted">{t('sync.noHistory')}</p>}
        {data && revs.length > 0 && (
          <div className="history-layout">
            <ul className="revision-list" role="listbox" aria-label={t('sync.historyTitle')}>
              {revs.map((r) => (
                <li
                  key={r.rev}
                  role="option"
                  aria-selected={r.rev === selected}
                  className={r.rev === selected ? 'active' : ''}
                  onClick={() => r.hasContent && setPicked(r.rev)}
                  aria-disabled={!r.hasContent}
                >
                  <strong>
                    #{r.rev} · {t(`sync.op_${r.op}`)}
                  </strong>
                  <span className="muted small">
                    {fmt(r.time)} · {r.mine ? t('sync.byYou') : t('sync.byOther')}
                  </span>
                </li>
              ))}
            </ul>
            {selected !== null && (
              <RevisionDiff
                key={selected}
                vaultId={vaultId}
                path={path}
                rev={selected}
                current={data.current}
              />
            )}
          </div>
        )}
        <div className="actions">
          <button onClick={close}>{t('settings.close')}</button>
          <button
            className="primary"
            disabled={busy || selected === null}
            onClick={() => void restore()}
          >
            {t('sync.restore')}
          </button>
        </div>
      </div>
    </div>
  );
}
