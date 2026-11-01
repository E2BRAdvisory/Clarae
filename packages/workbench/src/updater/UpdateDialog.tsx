import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { announced, connectUpdater, useUpdater } from './store';
import { Icon } from '../shell/icons';

/** Status-bar item: shown while a (not skipped) update is waiting. */
export function UpdateIndicator() {
  const { t } = useTranslation();
  const status = useUpdater((s) => s.status);
  useEffect(() => connectUpdater(), []);
  if (!announced(status)) return null;
  return (
    <button
      className="icon update-indicator"
      title={t('updater.available', { version: status?.latest })}
      onClick={() => useUpdater.getState().showDialog()}
    >
      <Icon name="upgrade" size={16} /> {t('updater.indicator', { version: status?.latest })}
    </button>
  );
}

const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);

/** "Update available" dialog with release notes (plain text: notes are never rendered as HTML). */
export function UpdateDialog() {
  const { t } = useTranslation();
  const { dialogOpen, status, message, error, busy } = useUpdater();
  if (!dialogOpen) return null;
  const close = () => useUpdater.getState().hideDialog();
  const available = !!status && ['available', 'downloading', 'ready'].includes(status.state);
  const downloading = status?.state === 'downloading';
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div
        className="modal updater"
        role="dialog"
        aria-modal="true"
        aria-labelledby="updater-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <h2 id="updater-title">{t('updater.title')}</h2>
        {busy && !available && <p className="muted">{t('updater.checking')}</p>}
        {!busy && status?.disabled && (
          <p className="muted">{t('updater.disabled', { reason: status.disabled })}</p>
        )}
        {!busy && status?.state === 'up-to-date' && (
          <p>{t('updater.upToDate', { version: status.current })}</p>
        )}
        {available && status && (
          <>
            <p>
              {t('updater.available', { version: status.latest })}{' '}
              <span className="muted">
                ({t('updater.current', { version: status.current })}, {status.channel})
              </span>
            </p>
            {status.required && <p role="alert">{t('updater.required')}</p>}
            {status.notes && (
              <>
                <h3>{t('updater.notes')}</h3>
                <pre className="update-notes">{status.notes}</pre>
              </>
            )}
            {downloading && (
              <progress
                aria-label={t('updater.downloading')}
                value={status.done}
                max={Math.max(status.size, 1)}
              />
            )}
            {downloading && (
              <p className="muted small">
                {mb(status.done)} / {mb(status.size)} MB
              </p>
            )}
          </>
        )}
        {/* The check worked but something about the channel is off (an expired manifest, …). */}
        {!busy && status?.warning && (
          <p className="warning small" role="note">
            {t('updater.warning', { warning: status.warning })}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        <div className="actions">
          {available && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void useUpdater.getState().install()}
            >
              {t('updater.install')}
            </button>
          )}
          <button onClick={close}>{available ? t('updater.later') : t('updater.close')}</button>
          {available && !status?.required && (
            <button disabled={busy} onClick={() => void useUpdater.getState().skip()}>
              {t('updater.skip')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
