import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useNote, useTree } from '../state/queries';
import { useActiveNote } from '../state/activeNote';
import { selectActivePath, useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { createdOf, formatSize, grantsCovering, lastEditor, textFigures } from './noteStats';

const when = (iso: string | undefined, lang: string, dateOnly = false): string =>
  !iso
    ? '—'
    : dateOnly
      ? new Date(iso).toLocaleDateString(lang, { dateStyle: 'medium', timeZone: 'UTC' })
      : new Date(iso).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });

/** Right sidebar, "Statistics" tab: figures of the note in focus (M8-WP7). */
export function StatsPanel({ vaultId }: { vaultId: string }) {
  const { t, i18n } = useTranslation();
  const path = useAppStore(selectActivePath);
  const stats = useAppStore((s) => s.stats);
  const profile = useAppStore((s) => s.auth?.profile);
  const info = useSync((s) => infoOf(s, vaultId));
  const live = useActiveNote((s) => (s.note?.path === path ? s.note.text : null));
  const isNote = !!path && path.toLowerCase().endsWith('.md');
  const { data: saved } = useNote(vaultId, isNote ? path : null);
  const text = live ?? saved?.content ?? '';
  const { data: tree = [] } = useTree(vaultId);
  const entry = tree.find((e) => e.path === path);

  const local = useQuery({
    queryKey: ['stats-versions', vaultId, path],
    queryFn: () => api.history.list(vaultId, path ?? ''),
    enabled: !!path,
  });
  const cloud = useQuery({
    queryKey: ['stats-revisions', vaultId, path],
    queryFn: () => api.sync.history(vaultId, path ?? ''),
    enabled: !!path && info.linked && !info.locked,
  });
  const owned = info.linked && info.kind === 'shared' && !info.mount;
  const shares = useQuery({
    queryKey: ['stats-shares', vaultId],
    queryFn: () => api.sharing.vaultShares(vaultId),
    enabled: owned,
  });

  // The cursor moves re-render this panel (stats): parse the note only when its text changes.
  const figures = useMemo(
    () => (isNote && path ? textFigures(path, text) : null),
    [isNote, path, text],
  );

  if (!path) return <div className="muted pad">{t('outline.none')}</div>;

  const modified = entry ? new Date(entry.mtime as string).toISOString() : undefined;
  const revisions = cloud.data ?? [];
  const firstRevision = revisions.length > 0 ? revisions[revisions.length - 1]?.time : undefined;
  const created = createdOf(text, firstRevision, modified);
  const grants = grantsCovering(shares.data ?? [], path);
  const editor = lastEditor(revisions, grants);
  const me = profile?.displayName || profile?.username || t('stats.you');
  const author = !info.linked
    ? me
    : editor?.kind === 'me'
      ? me
      : editor?.kind === 'user'
        ? editor.name
        : editor
          ? t('stats.otherUser')
          : '—';

  const sharing = (() => {
    if (!info.linked) return t('stats.notShared');
    if (info.kind === 'private') return t('stats.privateVault');
    if (info.mount)
      return t('stats.sharedBy', {
        owner: info.ownerName,
        level: t(`sharing.level_${info.permission || 'viewer'}`),
      });
    return null;
  })();

  return (
    <div className="content stats-panel" aria-label={t('stats.title')}>
      <dl>
        <dt>{t('stats.created')}</dt>
        <dd title={created.source === 'modified' ? t('stats.createdApprox') : undefined}>
          {created.source === 'modified' ? '≈ ' : ''}
          {when(created.time, i18n.language, created.dateOnly)}
        </dd>
        <dt>{t('stats.modified')}</dt>
        <dd>{when(modified, i18n.language)}</dd>
        <dt>{t('stats.author')}</dt>
        <dd>{author}</dd>
        <dt>{t('stats.versionsLocal')}</dt>
        <dd>{local.data?.length ?? '—'}</dd>
        {info.linked && (
          <>
            <dt>{t('stats.versionsCloud')}</dt>
            <dd>{cloud.data ? revisions.length : '—'}</dd>
          </>
        )}
        {entry && (
          <>
            <dt>{t('stats.size')}</dt>
            <dd>{formatSize(entry.size)}</dd>
          </>
        )}
        {figures && (
          <>
            <dt>{t('stats.words')}</dt>
            <dd>{figures.words}</dd>
            <dt>{t('stats.chars')}</dt>
            <dd>{figures.chars}</dd>
            <dt>{t('stats.chapters')}</dt>
            <dd>{figures.headings}</dd>
          </>
        )}
        {stats && figures && (
          <>
            <dt>{t('stats.position')}</dt>
            <dd>{t('status.position', { line: stats.line, col: stats.col })}</dd>
            {stats.selChars > 0 && (
              <>
                <dt>{t('stats.selection')}</dt>
                <dd>{t('status.selection', { words: stats.selWords, chars: stats.selChars })}</dd>
              </>
            )}
          </>
        )}
      </dl>
      <section className="stats-sharing" aria-label={t('stats.sharedWith')}>
        <h3>{t('stats.sharedWith')}</h3>
        {sharing !== null && <div className="muted">{sharing}</div>}
        {sharing === null && grants.length === 0 && (
          <div className="muted">{t('stats.notShared')}</div>
        )}
        {sharing === null &&
          grants.map((g) => (
            <div key={`${g.principalType}:${g.principalId}`} className="item">
              {g.principalName}
              <span className="muted">
                {' '}
                · {g.principalType === 'group' ? `${t('stats.group')} · ` : ''}
                {t(`sharing.level_${g.permission}`)}
              </span>
            </div>
          ))}
      </section>
    </div>
  );
}
