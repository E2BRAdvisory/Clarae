import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useSettings } from '../state/settings';
import { useCan } from '../platform';
import { useAppStore } from '../state/store';
import {
  importerApi,
  type ImportOptions,
  type ImportPreview,
  type ImportReport,
  type ImportSource,
} from './api';
import { ImporterEvents } from './events';
import { useImporter } from './store';
import { errorMessage } from '../util/errors';

type Step = 'source' | 'path' | 'options' | 'preview' | 'running' | 'report';

const ORDER = ['markdown-folder', 'notion', 'enex', 'roam', 'bear', 'google-keep', 'csv'];

const errText = (e: unknown): string => errorMessage(e);

/** The import wizard: source, file or folder, options, preview, run with progress, report. */
export function ImportWizard() {
  const open = useImporter((s) => s.open);
  if (!open) return null;
  return <ImportWizardDialog />;
}

/** The open wizard; App loads it on demand (it stays out of the startup bundle, ADR-0020). */
export function ImportWizardDialog() {
  const { t } = useTranslation();
  const hide = (): void => useImporter.getState().hide();
  const vault = useAppStore((s) => s.vault);
  const localFolders = useCan('localFolders');
  const attachmentsFolder = useSettings((s) => s.editor.attachmentsFolder);
  const [step, setStep] = useState<Step>('source');
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [path, setPath] = useState('');
  const [hint, setHint] = useState('');
  const [opts, setOpts] = useState<ImportOptions>({
    targetFolder: '',
    useWikilinks: true,
    attachmentsFolder: '',
    includeArchived: false,
    includeTrashed: false,
    csv: { delimiter: '', noHeader: false, titleColumn: '', bodyColumn: '' },
  });
  const [columns, setColumns] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>({
    done: 0,
    total: 0,
    current: '',
  });
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const jobId = useRef('');
  const heading = useRef<HTMLHeadingElement>(null);
  const vaultId = vault?.id ?? '';

  const source = sources.find((s) => s.id === sourceId);
  // Sources that need a folder of the computer are offered only where one can be opened.
  const importable = localFolders ? sources : sources.filter((s) => s.input !== 'folder');

  useEffect(() => {
    void importerApi.listSources().then((list) => {
      const sorted = [...list].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
      setSources(sorted);
      setSourceId((cur) => cur || sorted[0]?.id || '');
    });
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  // Progress and completion arrive as events; one import runs per vault at a time.
  useEffect(() => {
    const offs = [
      api.on(ImporterEvents.progress, (p) => {
        if (p.vaultId !== vaultId) return;
        setProgress({ done: p.done, total: p.total, current: p.current });
      }),
      api.on(ImporterEvents.done, (p) => {
        if (p.vaultId !== vaultId) return;
        setBusy(false);
        if (p.ok && p.report) {
          setReport(p.report);
          setStep('report');
        } else {
          setError(p.error);
          setStep('options');
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [vaultId]);

  const fail = (e: unknown): void => {
    setError(errText(e));
    setBusy(false);
  };

  const choose = async (kind: 'file' | 'folder'): Promise<void> => {
    setError('');
    try {
      const picked =
        kind === 'folder'
          ? await api.vault.pickFolder(t('importer.pickFolder'))
          : await importerApi.pickFile(t('importer.pickFile'), source?.extensions ?? []);
      if (!picked) return;
      setPath(picked);
      const found = await importerApi.detect(picked);
      setHint(found.length > 0 && !found.includes(sourceId) ? found[0]! : '');
    } catch (e) {
      fail(e);
    }
  };

  const toPath = (e: FormEvent): void => {
    e.preventDefault();
    if (sourceId) {
      setError('');
      setStep('path');
    }
  };

  const toOptions = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!path.trim()) return;
    setError('');
    setBusy(true);
    try {
      const folder = opts.targetFolder || (await importerApi.defaultFolder(sourceId));
      const next = {
        ...opts,
        targetFolder: folder,
        attachmentsFolder: opts.attachmentsFolder || attachmentsFolder,
      };
      setOpts(next);
      if (sourceId === 'csv') {
        // The columns are needed to map them.
        const pv = await importerApi.preview(vaultId, sourceId, path, next);
        setColumns(pv.columns);
        setOpts({
          ...next,
          csv: { ...next.csv, delimiter: pv.delimiter, titleColumn: pv.columns[0] ?? '' },
        });
      }
      setStep('options');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const toPreview = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      setPreview(await importerApi.preview(vaultId, sourceId, path, opts));
      setStep('preview');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    setError('');
    setBusy(true);
    setProgress({ done: 0, total: preview?.notes ?? 0, current: '' });
    setStep('running');
    try {
      jobId.current = await importerApi.run(vaultId, sourceId, path, opts);
    } catch (err) {
      setStep('preview');
      fail(err);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await importerApi.cancel(jobId.current);
    } catch (err) {
      fail(err);
    }
  };

  const close = (): void => {
    if (step === 'running') return;
    hide();
  };

  const openReport = (): void => {
    if (report?.reportPath) useAppStore.getState().openNote(report.reportPath);
    hide();
  };

  const setCsv = (patch: Partial<ImportOptions['csv']>): void =>
    setOpts((o) => ({ ...o, csv: { ...o.csv, ...patch } }));

  const stepNo = ['source', 'path', 'options', 'preview', 'running', 'report'].indexOf(step) + 1;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div
        className="modal importer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="importer-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (step === 'running') void cancel();
            else close();
          }
        }}
      >
        <h2 id="importer-title" ref={heading} tabIndex={-1}>
          {t('importer.title')}{' '}
          <span className="muted">{t('importer.step', { n: stepNo, total: 6 })}</span>
        </h2>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {step === 'source' && (
          <form onSubmit={toPath}>
            <fieldset>
              <legend>{t('importer.chooseSource')}</legend>
              {importable.map((s) => (
                <label key={s.id} className="row">
                  <input
                    type="radio"
                    name="source"
                    value={s.id}
                    checked={sourceId === s.id}
                    onChange={() => setSourceId(s.id)}
                  />
                  <span>
                    <strong>{t(`importer.source.${s.id}.name`)}</strong>
                    <br />
                    <span className="muted">{t(`importer.source.${s.id}.desc`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="actions">
              <button type="button" onClick={close}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="primary" disabled={!sourceId}>
                {t('importer.next')}
              </button>
            </div>
          </form>
        )}

        {step === 'path' && source && (
          <form onSubmit={(e) => void toOptions(e)}>
            <p className="muted">{t(`importer.source.${source.id}.how`)}</p>
            <label htmlFor="importer-path">{t('importer.location')}</label>
            <input
              id="importer-path"
              value={path}
              placeholder={t('importer.locationPlaceholder')}
              onChange={(e) => {
                setPath(e.target.value);
                setHint('');
              }}
              style={{ width: '100%' }}
            />
            <div className="actions">
              {source.input !== 'file' && localFolders && (
                <button type="button" onClick={() => void choose('folder')}>
                  {t('importer.chooseFolder')}
                </button>
              )}
              {source.input !== 'folder' && (
                <button type="button" onClick={() => void choose('file')}>
                  {t('importer.chooseFile')}
                </button>
              )}
            </div>
            {hint && hint !== sourceId && (
              <p className="muted">
                {t('importer.looksLike', { source: t(`importer.source.${hint}.name`) })}{' '}
                <button type="button" onClick={() => setSourceId(hint)}>
                  {t('importer.switchSource')}
                </button>
              </p>
            )}
            <div className="actions">
              <button type="button" onClick={() => setStep('source')}>
                {t('importer.back')}
              </button>
              <button type="submit" className="primary" disabled={!path.trim() || busy}>
                {t('importer.next')}
              </button>
            </div>
          </form>
        )}

        {step === 'options' && (
          <form onSubmit={(e) => void toPreview(e)}>
            <label htmlFor="importer-folder">{t('importer.targetFolder')}</label>
            <input
              id="importer-folder"
              value={opts.targetFolder}
              onChange={(e) => setOpts({ ...opts, targetFolder: e.target.value })}
              style={{ width: '100%' }}
            />
            <label className="row">
              <input
                type="checkbox"
                checked={opts.useWikilinks}
                onChange={(e) => setOpts({ ...opts, useWikilinks: e.target.checked })}
              />
              <span>{t('importer.useWikilinks')}</span>
            </label>
            <label htmlFor="importer-attachments">{t('importer.attachmentsFolder')}</label>
            <input
              id="importer-attachments"
              value={opts.attachmentsFolder}
              placeholder={t('importer.attachmentsPlaceholder')}
              onChange={(e) => setOpts({ ...opts, attachmentsFolder: e.target.value })}
              style={{ width: '100%' }}
            />
            {sourceId === 'google-keep' && (
              <>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={opts.includeArchived}
                    onChange={(e) => setOpts({ ...opts, includeArchived: e.target.checked })}
                  />
                  <span>{t('importer.includeArchived')}</span>
                </label>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={opts.includeTrashed}
                    onChange={(e) => setOpts({ ...opts, includeTrashed: e.target.checked })}
                  />
                  <span>{t('importer.includeTrashed')}</span>
                </label>
              </>
            )}
            {sourceId === 'csv' && (
              <>
                <label htmlFor="importer-delim">{t('importer.delimiter')}</label>
                <select
                  id="importer-delim"
                  value={opts.csv.delimiter}
                  onChange={(e) => setCsv({ delimiter: e.target.value })}
                >
                  <option value=",">{t('importer.delim_comma')}</option>
                  <option value=";">{t('importer.delim_semicolon')}</option>
                  <option value={'\t'}>{t('importer.delim_tab')}</option>
                  <option value="|">{t('importer.delim_pipe')}</option>
                </select>
                <label htmlFor="importer-title-col">{t('importer.titleColumn')}</label>
                <select
                  id="importer-title-col"
                  value={opts.csv.titleColumn}
                  onChange={(e) => setCsv({ titleColumn: e.target.value })}
                >
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <label htmlFor="importer-body-col">{t('importer.bodyColumn')}</label>
                <select
                  id="importer-body-col"
                  value={opts.csv.bodyColumn}
                  onChange={(e) => setCsv({ bodyColumn: e.target.value })}
                >
                  <option value="">{t('importer.noBody')}</option>
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <p className="muted">{t('importer.csvOthers')}</p>
              </>
            )}
            <div className="actions">
              <button type="button" onClick={() => setStep('path')}>
                {t('importer.back')}
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {t('importer.preview')}
              </button>
            </div>
          </form>
        )}

        {step === 'preview' && preview && (
          <div>
            <p>
              {t('importer.previewCounts', {
                notes: preview.notes,
                attachments: preview.attachments,
                folder: preview.targetFolder,
              })}
            </p>
            {preview.titles.length > 0 && (
              <>
                <h3>{t('importer.sampleTitles')}</h3>
                <ul>
                  {preview.titles.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </>
            )}
            {preview.warnings.length > 0 && (
              <>
                <h3>{t('importer.warnings')}</h3>
                <ul role="list" aria-label={t('importer.warnings')}>
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="actions">
              <button type="button" onClick={() => setStep('options')}>
                {t('importer.back')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={preview.notes === 0 && preview.attachments === 0}
                onClick={() => void start()}
              >
                {t('importer.start')}
              </button>
            </div>
          </div>
        )}

        {step === 'running' && (
          <div>
            <progress
              aria-label={t('importer.progress')}
              value={progress.done}
              max={Math.max(progress.total, progress.done, 1)}
              style={{ width: '100%' }}
            />
            <p role="status" className="muted">
              {t('importer.progressText', { done: progress.done, total: progress.total })}
              {progress.current ? ` — ${progress.current}` : ''}
            </p>
            <div className="actions">
              <button type="button" onClick={() => void cancel()}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {step === 'report' && report && (
          <div>
            <p role="status">
              {report.cancelled ? t('importer.cancelledReport') : t('importer.doneReport')}
            </p>
            <ul>
              <li>{t('importer.notesCreated', { count: report.notesCreated })}</li>
              <li>{t('importer.attachmentsCreated', { count: report.attachmentsCreated })}</li>
              <li>{t('importer.linksRewritten', { count: report.linksRewritten })}</li>
              <li>{t('importer.skipped', { count: report.skipped.length })}</li>
              <li>{t('importer.failed', { count: report.failed.length })}</li>
            </ul>
            {report.failed.length > 0 && (
              <>
                <h3>{t('importer.failedTitle')}</h3>
                <ul>
                  {report.failed.slice(0, 20).map((f, i) => (
                    <li key={i}>
                      {f.source}: {f.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report.warnings.length > 0 && (
              <>
                <h3>{t('importer.warnings')}</h3>
                <ul>
                  {report.warnings.slice(0, 20).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="actions">
              {report.reportPath && (
                <button type="button" onClick={openReport}>
                  {t('importer.openReport')}
                </button>
              )}
              <button type="button" className="primary" autoFocus onClick={() => hide()}>
                {t('common.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
