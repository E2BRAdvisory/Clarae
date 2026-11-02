import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, InlineError, SelectField, Table, TextField } from '@memobrain/ui';
import {
  ExportInterruptedError,
  expireWhenIdle,
  exportPrivateVault,
  type ExportReport,
  type Secret,
} from '@memobrain/vaultcrypto-web';
import { ApiError } from '@memobrain/api-client';
import { useApi } from '../api/context';
import { describeError } from '../api/errors';
import { useVaultLockMs } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';
import { downloadBlob } from '../export/download';
import {
  classifyUnlockError,
  openPrivateVault,
  retryableBlobError,
  type PrivateSession,
  type UnlockFailure,
} from '../export/privateExport';
import { BLOB_WARN_BYTES, canSaveToDisk, saveZipStream, type SaveMethod } from '../export/save';
import {
  ExportJobError,
  exportShared,
  fallbackName,
  fetchDownload,
  isAbort,
  openDownload,
  type SharedExportEvent,
} from '../export/sharedExport';
import { formatBytes } from '../format';

interface VaultRef {
  id: string;
  name: string;
}

/* ---- Shared vault: direct stream, falling back to an export job ------------------------- */

/** How often the download progress of a shared export is redrawn. */
const PROGRESS_MS = 250;

/** A ready archive that the API serves itself: downloaded with the token when the user saves it. */
interface ApiDownload {
  url: string;
  filename: string;
  size?: number;
}

type SharedPhase =
  | { kind: 'direct' }
  | { kind: 'job'; status: 'queued' | 'running' | 'ready' | 'failed' | 'expired' }
  | { kind: 'save'; target: ApiDownload }
  | { kind: 'saving'; target: ApiDownload; received: number; total?: number }
  | { kind: 'saved'; filename: string; method: SaveMethod }
  | { kind: 'done'; filename: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

function SharedExportDialog({ vault, onClose }: { vault: VaultRef; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { getAccessToken } = useAuth();
  const [phase, setPhase] = useState<SharedPhase>({ kind: 'direct' });
  const abort = useRef<AbortController | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ExportJobError)
        return setPhase({
          kind: 'error',
          message:
            err.status === 'expired'
              ? t('vaultExport.jobExpired')
              : t('vaultExport.jobFailed', { error: err.message || '—' }),
        });
      setPhase({ kind: 'error', message: describeError(err, t) });
    },
    [t],
  );

  useEffect(() => {
    const ac = new AbortController();
    abort.current = ac;
    const onEvent = (e: SharedExportEvent) =>
      setPhase(e.kind === 'direct' ? { kind: 'direct' } : { kind: 'job', status: e.status });
    exportShared({ api, getToken: getAccessToken }, vault, { signal: ac.signal, onEvent })
      .then((result) => {
        if (abort.current !== ac || ac.signal.aborted) return;
        if (result.kind === 'download') {
          // Saving is a click of its own: the file picker needs the user's gesture.
          const { url, filename, size } = result;
          return setPhase({ kind: 'save', target: { url, filename, ...(size ? { size } : {}) } });
        }
        if (result.kind === 'blob') downloadBlob(result.blob, result.filename);
        else openDownload(result.url, result.filename);
        setPhase({ kind: 'done', filename: result.filename });
      })
      .catch((err: unknown) => {
        if (abort.current !== ac) return; // superseded (React StrictMode remount)
        if (isAbort(err) || ac.signal.aborted) return setPhase({ kind: 'cancelled' });
        fail(err);
      });
    // Leaving the page stops the transfer and the polling, and a download being saved.
    return () => {
      ac.abort();
      abort.current?.abort();
    };
    // The export starts once per dialog instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Streams the archive from the API into the file the user picks (or a Blob without the picker). */
  const save = async (target: ApiDownload) => {
    const ac = new AbortController();
    abort.current = ac;
    setPhase({
      kind: 'saving',
      target,
      received: 0,
      ...(target.size ? { total: target.size } : {}),
    });
    let filename = target.filename;
    let shown = 0; // the progress is redrawn a few times a second, not once per network chunk
    try {
      const method = await saveZipStream(
        async () => {
          const d = await fetchDownload({ api, getToken: getAccessToken }, target.url, filename, {
            signal: ac.signal,
            onBytes: (received, total) => {
              const now = Date.now();
              if (now - shown < PROGRESS_MS) return;
              shown = now;
              setPhase((p) =>
                p.kind === 'saving'
                  ? { ...p, received, ...((total ?? p.total) ? { total: total ?? p.total } : {}) }
                  : p,
              );
            },
          });
          filename = d.filename;
          return d;
        },
        target.filename,
        ac.signal,
      );
      if (abort.current === ac) setPhase({ kind: 'saved', filename, method });
    } catch (err) {
      if (abort.current !== ac) return;
      if (ac.signal.aborted) return setPhase({ kind: 'cancelled' });
      // The file picker was dismissed: nothing was downloaded, the archive can still be saved.
      if (isAbort(err)) return setPhase({ kind: 'save', target });
      fail(err);
    }
  };

  const busy =
    phase.kind === 'direct' ||
    phase.kind === 'saving' ||
    (phase.kind === 'job' && phase.status !== 'ready');
  let status: string;
  switch (phase.kind) {
    case 'direct':
      return renderShared(t('vaultExport.downloading'), true);
    case 'job':
      status = t(`vaultExport.job_${phase.status}`);
      return renderShared(status, busy);
    case 'save':
    case 'saving':
      return renderSave(phase);
    case 'saved':
      return renderShared(
        phase.method === 'disk'
          ? t('vaultExport.saved', { name: phase.filename })
          : t('vaultExport.done', { name: phase.filename }),
        false,
      );
    case 'done':
      return renderShared(t('vaultExport.done', { name: phase.filename }), false);
    case 'cancelled':
      return renderShared(t('vaultExport.cancelled'), false);
    case 'error':
      return renderShared(phase.message, false, true);
  }

  function renderSave(p: Extract<SharedPhase, { kind: 'save' | 'saving' }>) {
    const size = p.kind === 'saving' ? p.total : p.target.size;
    const memoryWarning = !canSaveToDisk() && size !== undefined && size > BLOB_WARN_BYTES;
    return (
      <Dialog
        title={t('vaultExport.title', { name: vault.name })}
        onClose={p.kind === 'saving' ? () => abort.current?.abort() : onClose}
        actions={
          p.kind === 'saving' ? (
            <Button onClick={() => abort.current?.abort()}>{t('common.cancel')}</Button>
          ) : (
            <>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={() => void save(p.target)}>
                {t('vaultExport.saveZip')}
              </Button>
            </>
          )
        }
      >
        {p.kind === 'save' ? (
          <div className="nd-stack">
            <p role="status">
              {t('vaultExport.jobReadySave', { size: formatBytes(p.target.size ?? 0) })}
            </p>
            <p className="nd-muted">
              {canSaveToDisk() ? t('vaultExport.saveToDisk') : t('vaultExport.saveBlob')}
            </p>
            {memoryWarning && <InlineError>{t('vaultExport.memoryWarning')}</InlineError>}
          </div>
        ) : (
          <div className="nd-stack">
            <progress
              className="admin-progress"
              aria-label={t('vaultExport.exporting')}
              {...(p.total ? { max: p.total, value: p.received } : {})}
            />
            <p role="status">
              {t('vaultExport.downloadProgress', {
                done: formatBytes(p.received),
                total: p.total ? formatBytes(p.total) : '—',
              })}
            </p>
          </div>
        )}
      </Dialog>
    );
  }

  function renderShared(message: string, working: boolean, isError = false) {
    return (
      <Dialog
        title={t('vaultExport.title', { name: vault.name })}
        onClose={onClose}
        actions={
          working ? (
            <Button onClick={() => abort.current?.abort()}>{t('common.cancel')}</Button>
          ) : (
            <Button variant="primary" onClick={onClose}>
              {t('common.close')}
            </Button>
          )
        }
      >
        {phase.kind === 'direct' && <p className="nd-muted">{t('vaultExport.sharedNote')}</p>}
        {working && <progress className="admin-progress" aria-label={message} />}
        {isError ? <InlineError>{message}</InlineError> : <p role="status">{message}</p>}
      </Dialog>
    );
  }
}

function SharedExport({ vault }: { vault: VaultRef }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        small
        aria-label={t('vaultExport.downloadAria', { name: vault.name })}
        onClick={() => setOpen(true)}
      >
        {t('vaultExport.download')}
      </Button>
      {open && <SharedExportDialog vault={vault} onClose={() => setOpen(false)} />}
    </>
  );
}

/* ---- Private vault: decrypted and zipped in the browser ------------------------------------ */

type PrivatePhase =
  | { kind: 'form' }
  | { kind: 'unlocking' }
  | { kind: 'ready' }
  | { kind: 'exporting' }
  | { kind: 'done'; method: 'disk' | 'blob'; filename: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

interface Progress {
  exported: number;
  skipped: number;
  total: number;
}

function reasonText(t: (k: string) => string, reason: string): string {
  return t(`vaultExport.reason_${reason}`);
}

function failureText(t: (k: string) => string, f: UnlockFailure): string {
  return t(`vaultExport.failure_${f}`);
}

function PrivateExportDialog({ vault, onClose }: { vault: VaultRef; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const [phase, setPhase] = useState<PrivatePhase>({ kind: 'form' });
  const [mode, setMode] = useState<Secret['kind']>('passphrase');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({ exported: 0, skipped: 0, total: 0 });
  const [report, setReport] = useState<ExportReport | null>(null);
  const [info, setInfo] = useState<{ files: number; bytes: number } | null>(null);
  // Key material lives only here, in memory, and is wiped when the dialog ends, or when it stays
  // unlocked and unused for the time the core locks a private vault after (vault_lock_minutes).
  const session = useRef<PrivateSession | null>(null);
  const abort = useRef<AbortController | null>(null);
  const expiry = useRef<ReturnType<typeof expireWhenIdle> | null>(null);
  const lockMs = useVaultLockMs();

  const wipe = useCallback(() => {
    expiry.current?.stop();
    expiry.current = null;
    session.current?.keys.wipe();
    session.current = null;
  }, []);
  useEffect(
    () => () => {
      abort.current?.abort();
      wipe();
    },
    [wipe],
  );

  const close = () => {
    abort.current?.abort();
    wipe();
    setSecret('');
    onClose();
  };

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    if (secret.trim() === '') return setError(t('vaultExport.secretRequired'));
    setError(null);
    setPhase({ kind: 'unlocking' });
    const ac = new AbortController();
    abort.current = ac;
    const value: Secret =
      mode === 'passphrase'
        ? { kind: 'passphrase', passphrase: secret }
        : { kind: 'recovery', recoveryKey: secret };
    try {
      const opened = await openPrivateVault(api, vault.id, value, ac.signal);
      session.current = opened;
      setSecret(''); // the secret is not needed any more
      setInfo({ files: opened.tree.length, bytes: opened.totalBytes });
      expiry.current = expireWhenIdle(opened.keys, lockMs, () => {
        if (session.current === opened) session.current = null;
        expiry.current = null;
        setInfo(null);
        setError(t('vaultExport.expired'));
        setPhase({ kind: 'form' });
      });
      setPhase({ kind: 'ready' });
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) return setPhase({ kind: 'cancelled' });
      const failure = classifyUnlockError(err);
      setError(
        failure === 'api' && err instanceof ApiError
          ? describeError(err, t)
          : failureText(t, failure),
      );
      setPhase({ kind: 'form' });
    }
  };

  const save = async () => {
    const s = session.current;
    if (!s) return;
    // In use from here: no expiry while the archive is written (the keys are wiped at the end).
    expiry.current?.pause();
    const ac = new AbortController();
    abort.current = ac;
    const filename = fallbackName(vault.name);
    setProgress({ exported: 0, skipped: 0, total: s.tree.length });
    setReport(null);
    setPhase({ kind: 'exporting' });
    const { stream, report: live } = exportPrivateVault({
      vaultId: vault.id,
      keys: s.keys.keys,
      source: s.source,
      signal: ac.signal,
      // A blob the network, the session or the server failed to deliver is tried again, then stops the
      // export: only a blob the server does not have is skipped as missing.
      isRetryable: retryableBlobError,
      onProgress: (r) =>
        setProgress({ exported: r.exported, skipped: r.skipped.length, total: r.total }),
    });
    try {
      const method = await saveZipStream(stream, filename, ac.signal);
      setReport({ ...live, skipped: [...live.skipped] });
      setPhase({ kind: 'done', method, filename });
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) setPhase({ kind: 'cancelled' });
      else {
        setError(describeExportError(err));
        setPhase({ kind: 'error', message: describeExportError(err) });
      }
    } finally {
      wipe();
    }
  };

  const describeExportError = (err: unknown): string =>
    err instanceof ExportInterruptedError
      ? t('vaultExport.interrupted', {
          path: err.path,
          reason:
            err.cause instanceof ApiError
              ? describeError(err.cause, t)
              : err.cause instanceof Error && err.cause.message
                ? err.cause.message
                : t('common.errorGeneric'),
        })
      : err instanceof ApiError
        ? describeError(err, t)
        : err instanceof Error && err.message
          ? t('vaultExport.exportFailed', { message: err.message })
          : t('common.errorGeneric');

  const working = phase.kind === 'unlocking' || phase.kind === 'exporting';
  const memoryWarning = info !== null && !canSaveToDisk() && info.bytes > BLOB_WARN_BYTES;

  let body: React.ReactNode;
  let actions: React.ReactNode;
  switch (phase.kind) {
    case 'form':
    case 'unlocking':
      body = (
        <form
          id="private-export-form"
          onSubmit={(e) => void unlock(e)}
          noValidate
          className="nd-stack"
        >
          <p>{t('vaultExport.privateIntro')}</p>
          <SelectField
            label={t('vaultExport.method')}
            value={mode}
            disabled={phase.kind === 'unlocking'}
            onChange={(e) => {
              setMode(e.target.value as Secret['kind']);
              setSecret('');
              setError(null);
            }}
          >
            <option value="passphrase">{t('vaultExport.passphrase')}</option>
            <option value="recovery">{t('vaultExport.recoveryKey')}</option>
          </SelectField>
          {mode === 'passphrase' ? (
            <TextField
              key="pass"
              label={t('vaultExport.passphrase')}
              type="password"
              autoComplete="off"
              disabled={phase.kind === 'unlocking'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          ) : (
            <TextField
              key="rec"
              label={t('vaultExport.recoveryKey')}
              hint={t('vaultExport.recoveryHint')}
              type="text"
              autoComplete="off"
              spellCheck={false}
              disabled={phase.kind === 'unlocking'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
          {phase.kind === 'unlocking' && (
            <>
              <progress className="admin-progress" aria-label={t('vaultExport.unlocking')} />
              <p role="status">{t('vaultExport.unlocking')}</p>
            </>
          )}
          {error && <InlineError>{error}</InlineError>}
        </form>
      );
      actions =
        phase.kind === 'unlocking' ? (
          <Button onClick={() => abort.current?.abort()}>{t('common.cancel')}</Button>
        ) : (
          <>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button type="submit" form="private-export-form" variant="primary">
              {t('vaultExport.unlock')}
            </Button>
          </>
        );
      break;
    case 'ready':
      body = (
        <div className="nd-stack">
          <p role="status">
            {t('vaultExport.unlocked', {
              files: info?.files ?? 0,
              size: formatBytes(info?.bytes ?? 0),
            })}
          </p>
          <p className="nd-muted">
            {canSaveToDisk() ? t('vaultExport.saveToDisk') : t('vaultExport.saveBlob')}
          </p>
          {memoryWarning && <InlineError>{t('vaultExport.memoryWarning')}</InlineError>}
        </div>
      );
      actions = (
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t('vaultExport.saveZip')}
          </Button>
        </>
      );
      break;
    case 'exporting':
      body = (
        <div className="nd-stack">
          <progress
            className="admin-progress"
            aria-label={t('vaultExport.exporting')}
            max={Math.max(progress.total, 1)}
            value={progress.exported + progress.skipped}
          />
          <p role="status">
            {t('vaultExport.progress', {
              done: progress.exported + progress.skipped,
              total: progress.total,
            })}
          </p>
        </div>
      );
      actions = <Button onClick={() => abort.current?.abort()}>{t('common.cancel')}</Button>;
      break;
    case 'done':
      body = (
        <div className="nd-stack">
          <p role="status">
            {t('vaultExport.privateDone', {
              name: phase.filename,
              files: report?.exported ?? 0,
              size: formatBytes(report?.bytes ?? 0),
            })}
          </p>
          {report && report.skipped.length > 0 ? (
            <>
              <InlineError>
                {t('vaultExport.skipped', { count: report.skipped.length })}
              </InlineError>
              <Table caption={t('vaultExport.skippedTitle')}>
                <thead>
                  <tr>
                    <th scope="col">{t('vaultExport.file')}</th>
                    <th scope="col">{t('vaultExport.reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.skipped.map((s, i) => (
                    <tr key={`${s.path}:${i}`}>
                      <th scope="row">{s.path}</th>
                      <td>{reasonText(t, s.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          ) : (
            <p>{t('vaultExport.noneSkipped')}</p>
          )}
        </div>
      );
      actions = (
        <Button variant="primary" onClick={close}>
          {t('common.close')}
        </Button>
      );
      break;
    case 'cancelled':
      body = <p role="status">{t('vaultExport.cancelledPrivate')}</p>;
      actions = (
        <Button variant="primary" onClick={close}>
          {t('common.close')}
        </Button>
      );
      break;
    case 'error':
      body = <InlineError>{phase.message}</InlineError>;
      actions = (
        <Button variant="primary" onClick={close}>
          {t('common.close')}
        </Button>
      );
      break;
  }

  return (
    <Dialog
      title={t('vaultExport.privateTitle', { name: vault.name })}
      onClose={working ? () => abort.current?.abort() : close}
      actions={actions}
    >
      {body}
    </Dialog>
  );
}

function PrivateExport({ vault }: { vault: VaultRef }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        small
        aria-label={t('vaultExport.downloadPrivateAria', { name: vault.name })}
        onClick={() => setOpen(true)}
      >
        {t('vaultExport.downloadPrivate')}
      </Button>
      {open && <PrivateExportDialog vault={vault} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Download button for a vault the user owns: direct/job export for shared, in-browser for private. */
export function VaultExport({ vault, kind }: { vault: VaultRef; kind: 'private' | 'shared' }) {
  return kind === 'private' ? <PrivateExport vault={vault} /> : <SharedExport vault={vault} />;
}
