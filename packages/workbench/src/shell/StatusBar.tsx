import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { classify } from '../embeds/media';
import { isGraphPath } from '../graph/paths';
import { textFigures } from '../sidebar/noteStats';
import { useSlideshow } from '../slides/store';
import { useActiveNote } from '../state/activeNote';
import { useNote } from '../state/queries';
import { useSettings, type NoteMode } from '../state/settings';
import { useAppStore } from '../state/store';
import { activeTab } from '../workspace/layout';

const NEXT_MODE: Record<NoteMode, NoteMode> = {
  live: 'source',
  source: 'reading',
  reading: 'live',
};

/** Label of a tab that is not a note: only its type is shown. */
function kindLabel(path: string): string {
  if (isGraphPath(path)) return 'status.kindGraph';
  switch (classify(path)) {
    case 'drawing':
      return 'status.kindDrawing';
    case 'canvas':
      return 'status.kindCanvas';
    case 'base':
      return 'status.kindBase';
    default:
      return 'status.kindFile';
  }
}

/**
 * Compact status bar under the editor area (ADR-0035): figures of the active editor only, off by
 * default. Sync, permissions, updates and invitations stay in the vault status (ADR-0026). No
 * aria-live: counts announced at every key would be noise; the Statistics panel reads them out.
 */
export function StatusBar({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const on = useSettings((s) => s.appearance.statusBar);
  const presenting = useSlideshow((s) => s.open);
  if (!on || presenting) return null;
  return (
    <div className="status-bar" role="status" aria-label={t('status.label')}>
      <Figures vaultId={vaultId} />
    </div>
  );
}

function Figures({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const tab = useAppStore((s) => activeTab(s.layout));
  const setTabMode = useAppStore((s) => s.setTabMode);
  const stats = useAppStore((s) => s.stats);
  const path = tab?.path ?? null;
  const isNote = !!path && !isGraphPath(path) && /\.md$/i.test(path);
  const live = useActiveNote((s) => (s.note?.path === path ? s.note.text : null));
  const { data: saved } = useNote(vaultId, isNote ? path : null);
  const text = live ?? saved?.content ?? '';
  // The same figures as the Statistics panel; the cursor moves re-render: parse on text changes.
  const figures = useMemo(
    () => (isNote && path ? textFigures(path, text) : null),
    [isNote, path, text],
  );

  if (!tab || !path) return null;
  if (!figures) return <span className="status-item">{t(kindLabel(path))}</span>;

  // Without an editor (reading view) there is no cursor nor selection to show.
  const editing = tab.mode !== 'reading' && stats !== null;
  const selected = editing && stats.selChars > 0;
  return (
    <>
      <span className="status-item">
        {selected
          ? t('status.selection', { words: stats.selWords, chars: stats.selChars })
          : t('status.counts', { words: figures.words, chars: figures.chars })}
      </span>
      {editing && (
        <span className="status-item">
          {t('status.position', { line: stats.line, col: stats.col })}
        </span>
      )}
      <button
        type="button"
        className="status-item status-mode"
        title={t('status.mode', { mode: t(`editor.mode_${tab.mode}`) })}
        aria-label={t('status.mode', { mode: t(`editor.mode_${tab.mode}`) })}
        onClick={() => setTabMode(tab.id, NEXT_MODE[tab.mode])}
      >
        {t(`editor.mode_${tab.mode}`)}
      </button>
    </>
  );
}
