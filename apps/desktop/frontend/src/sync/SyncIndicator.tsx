import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';

const ICON: Record<string, string> = {
  idle: '☁',
  syncing: '⟳',
  paused: '⏸',
  offline: '⚠',
  error: '⚠',
  locked: '🔒',
};

/** Status bar indicator of the vault's cloud synchronization (M2-WP8). */
export function SyncIndicator() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const info = useSync((s) => infoOf(s, vault?.id));
  const status = useSync((s) => (vault ? s.status[vault.id] : undefined));
  const conflicts = useSync((s) => (vault ? (s.conflicts[vault.id]?.length ?? 0) : 0));
  if (!vault) return null;

  if (!info.linked) {
    return (
      <button
        className="icon sync-indicator"
        title={t('sync.connectTitle')}
        onClick={() => useSync.getState().setWizardOpen(true)}
      >
        ☁ {t('sync.notConnected')}
      </button>
    );
  }
  const phase = info.locked ? 'locked' : (status?.phase ?? 'idle');
  const label =
    phase === 'syncing' && status && status.total > 0
      ? t('sync.syncingN', { done: status.done, total: status.total })
      : phase === 'idle' && (status?.pending ?? 0) > 0
        ? t('sync.pendingN', { count: status?.pending ?? 0 })
        : t(`sync.phase_${phase}`);
  const open = () => {
    if (phase === 'locked') useSync.getState().setUnlockOpen(true);
    else useAppStore.getState().openSettings('sync');
  };
  return (
    <>
      {/* Announces sync state changes to screen readers; the button below is the visual control. */}
      <span className="sr-only" role="status" aria-live="polite">
        {`${t('sync.title')}: ${label}`}
      </span>
      <button
        className={`icon sync-indicator ${phase}`}
        title={status?.error || label}
        aria-label={`${t('sync.title')}: ${label}`}
        onClick={open}
      >
        {ICON[phase]} {label}
      </button>
      {conflicts > 0 && (
        <button
          className="icon sync-conflicts"
          title={t('sync.conflictsTitle')}
          onClick={() => useSync.getState().setConflictsOpen(true)}
        >
          ⚡ {t('sync.conflictsN', { count: conflicts })}
        </button>
      )}
    </>
  );
}
