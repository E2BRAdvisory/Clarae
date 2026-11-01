import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18next } from '../i18n';
import { api } from '../app/api';
import { lockVault } from '../app/actions';
import { useAppStore } from '../state/store';
import { isLocked, useManaged } from '../state/managed';
import { infoOf, useSync } from '../state/sync';
import { Icon } from '../shell/icons';
import { dialog } from '../ui/dialogs';
import { PassphraseFields } from '../sync/PassphraseFields';
import { RecoveryKeyStep } from '../sync/RecoveryKeyStep';

const POLL_OPTIONS = [0, 30, 60, 300, 900];
/** Idle minutes before a private vault locks itself (0 = never). */
export const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60, 240];
const AUTO_LOCK_KEY = 'security.vault_lock_minutes';

/** The administrator's idle timeout, when the profile sets one. */
function managedLockMinutes(config: Record<string, unknown>): number | undefined {
  const sec = config['security'];
  if (typeof sec !== 'object' || sec === null) return undefined;
  const v = (sec as Record<string, unknown>)['vault_lock_minutes'];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Idle timeout of private vaults (§3.8.2), a device setting: a locked administrator value wins,
 * then the user's choice, then the administrator's default, then never (as in the backend).
 */
function AutoLockRow() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const locked = useManaged((m) => isLocked(m.locked, AUTO_LOCK_KEY));
  const managed = useManaged((m) => managedLockMinutes(m.config));
  const value = locked ? (managed ?? 0) : (settings.vaultLockMinutes ?? managed ?? 0);
  const options = AUTO_LOCK_OPTIONS.includes(value)
    ? AUTO_LOCK_OPTIONS
    : [...AUTO_LOCK_OPTIONS, value];
  const change = async (minutes: number) => {
    const next = { ...settings, vaultLockMinutes: minutes };
    useAppStore.getState().setSettings(next);
    try {
      await api.settings.set(next);
    } catch (e) {
      await dialog.error(e);
    }
  };
  return (
    <div className={`row${locked ? ' managed' : ''}`}>
      <label htmlFor="auto-lock">{t('sync.autoLock')}</label>
      <select
        id="auto-lock"
        value={value}
        disabled={locked}
        onChange={(e) => void change(Number(e.target.value))}
      >
        {options.map((m) => (
          <option key={m} value={m}>
            {m === 0
              ? t('sync.autoLockNever')
              : m % 60 === 0
                ? t('sync.autoLockHours', { n: m / 60 })
                : t('sync.autoLockMinutes', { n: m })}
          </option>
        ))}
      </select>
      {locked && (
        <span className="muted small managed-note">
          <Icon name="lock" size={14} /> {t('settings.managedByAdmin')}
        </span>
      )}
    </div>
  );
}

function ChangePassphrase({ vaultId, onDone }: { vaultId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [oldPass, setOldPass] = useState('');
  const [fresh, setFresh] = useState('');
  const [busy, setBusy] = useState(false);
  const onValid = useCallback((p: string) => setFresh(p), []);
  const save = async () => {
    setBusy(true);
    try {
      await api.crypto.changePassphrase(vaultId, oldPass, fresh);
      onDone();
    } catch (e) {
      await dialog.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inline-form">
      <label htmlFor="old-pass">{t('sync.currentPassphrase')}</label>
      <input
        id="old-pass"
        type="password"
        autoComplete="current-password"
        value={oldPass}
        onChange={(e) => setOldPass(e.target.value)}
      />
      <PassphraseFields idPrefix="change" onValid={onValid} />
      <div className="actions">
        <button onClick={onDone}>{t('dialog.cancel')}</button>
        <button
          className="primary"
          disabled={busy || oldPass === '' || fresh === ''}
          onClick={() => void save()}
        >
          {t('sync.savePassphrase')}
        </button>
      </div>
    </div>
  );
}

/** Settings > Sync: status, pause, interval, disconnect, and the encryption controls of private vaults. */
export function SyncSection() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const info = useSync((s) => infoOf(s, vault?.id));
  const status = useSync((s) => (vault ? s.status[vault.id] : undefined));
  const conflicts = useSync((s) => (vault ? (s.conflicts[vault.id]?.length ?? 0) : 0));
  const disk = useSync((s) => s.diskWarning);
  const [form, setForm] = useState<'none' | 'passphrase' | 'recovery'>('none');
  const [newKey, setNewKey] = useState('');
  const auth = useAppStore((s) => s.auth);
  const setAuth = useAppStore((s) => s.setAuth);
  const [signingIn, setSigningIn] = useState(false);

  if (!vault) return <p className="muted">{t('settings.needsVault')}</p>;
  const id = vault.id;
  const refresh = () => useSync.getState().refresh(id);
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      await dialog.error(e);
    }
    await refresh();
  };

  if (!info.linked) {
    return (
      <>
        <p className="muted">{t('sync.notConnectedText')}</p>
        <div className="actions">
          <button className="primary" onClick={() => useSync.getState().setWizardOpen(true)}>
            {t('sync.connectTitle')}
          </button>
        </div>
      </>
    );
  }

  const phase = info.locked ? 'locked' : (status?.phase ?? 'idle');
  const regenerate = async () => {
    const pass = await dialog.prompt(t('sync.regenerateKey'), '', t('sync.currentPassphrase'));
    if (!pass) return;
    try {
      setNewKey(await api.crypto.regenerateRecoveryKey(id, pass));
      setForm('recovery');
    } catch (e) {
      await dialog.error(e);
    }
  };

  return (
    <>
      <div className="row">
        <span>{t('sync.vaultName')}</span>
        <strong>
          {info.name} · {t(`sync.kind_${info.kind}`)}
        </strong>
      </div>
      <div className="row">
        <span>{t('sync.server')}</span>
        <span className="muted">{info.serverUrl}</span>
      </div>
      <div className="row">
        <span>{t('sync.status')}</span>
        <span aria-live="polite">
          {t(`sync.phase_${phase}`)}
          {status?.lastSync && status.lastSync !== '0001-01-01T00:00:00Z'
            ? ` · ${t('sync.lastSync', { time: new Date(status.lastSync).toLocaleTimeString(i18next.language) })}`
            : ''}
        </span>
      </div>
      {(auth?.status ?? 'signed_out') === 'signed_out' && (
        <div className="row">
          <span className="muted">{t('sync.signedOutHint')}</span>
          <button
            className="primary"
            disabled={signingIn}
            onClick={() => {
              setSigningIn(true);
              void api.auth
                .login(info.serverUrl)
                .then(setAuth)
                .catch(async () => setAuth(await api.auth.status()))
                .finally(() => setSigningIn(false));
            }}
          >
            {t('cloud.login')}
          </button>
        </div>
      )}
      {status?.error && (
        <div className="error small" role="alert">
          {status.error}
        </div>
      )}
      {conflicts > 0 && (
        <div className="row">
          <span>{t('sync.conflictsN', { count: conflicts })}</span>
          <button onClick={() => useSync.getState().setConflictsOpen(true)}>
            {t('sync.resolve')}
          </button>
        </div>
      )}
      <div className="row">
        <label htmlFor="poll">{t('sync.pollInterval')}</label>
        <select
          id="poll"
          value={info.pollSeconds}
          onChange={(e) => void guard(() => api.sync.setPollInterval(id, Number(e.target.value)))}
        >
          {POLL_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === 0
                ? t('sync.pollAuto')
                : s < 60
                  ? t('sync.everySeconds', { n: s })
                  : t('sync.everyMinutes', { n: s / 60 })}
            </option>
          ))}
        </select>
      </div>
      <div className="actions left">
        <button onClick={() => void guard(() => api.sync.syncNow(id))} disabled={info.locked}>
          {t('sync.syncNow')}
        </button>
        <button onClick={() => void guard(() => api.sync.setPaused(id, !info.paused))}>
          {info.paused ? t('sync.resume') : t('sync.pause')}
        </button>
        <button
          className="danger"
          onClick={() =>
            void (async () => {
              if (await dialog.confirm(t('sync.disconnect'), t('sync.disconnectText'), true))
                await guard(() => api.sync.unlink(id));
            })()
          }
        >
          {t('sync.disconnect')}
        </button>
      </div>

      {info.kind === 'private' && (
        <>
          <h3>{t('sync.encryption')}</h3>
          {disk && (
            <div className="warning small" role="alert">
              {t('sync.diskUnencrypted')}
            </div>
          )}
          <p className="muted small">{t('sync.encryptionText')}</p>
          <AutoLockRow />
          <p className="muted small">{t('sync.autoLockHint')}</p>
          {form === 'none' && (
            <div className="actions left">
              {info.locked ? (
                <button onClick={() => useSync.getState().setUnlockOpen(true)}>
                  {t('sync.unlock')}
                </button>
              ) : (
                <button onClick={() => void guard(() => lockVault(id))}>{t('sync.lockNow')}</button>
              )}
              <button disabled={info.locked} onClick={() => setForm('passphrase')}>
                {t('sync.changePassphrase')}
              </button>
              <button disabled={info.locked} onClick={() => void regenerate()}>
                {t('sync.regenerateKey')}
              </button>
            </div>
          )}
          {form === 'passphrase' && (
            <ChangePassphrase
              vaultId={id}
              onDone={() => {
                setForm('none');
                void refresh();
              }}
            />
          )}
          {form === 'recovery' && (
            <RecoveryKeyStep recoveryKey={newKey} onConfirmed={() => setForm('none')} />
          )}
        </>
      )}
    </>
  );
}
