// In-memory ImporterAPI for Vitest and browser-only runs (installed by test/wails-mock).
import type { ImportDonePayload, ImportProgressPayload } from './events';
import { Events } from '../app/events';
import type { ImportOptions, ImportPreview, ImportReport, ImportSource } from './api';

export interface ImporterMockCall {
  vaultId: string;
  sourceId: string;
  path: string;
  opts: ImportOptions;
}

export interface ImporterMockState {
  sources: ImportSource[];
  picked: string;
  preview: ImportPreview;
  report: ImportReport;
  /** When set, Run fails with this message. */
  runError: string;
  /** Keep the job running until finish() is called (to test progress and cancel). */
  hold: boolean;
  previews: ImporterMockCall[];
  runs: ImporterMockCall[];
  cancelled: string[];
  /** Completes the held job. */
  finish: () => void;
}

const SOURCES: [string, 'file' | 'folder' | 'either', string[]][] = [
  ['markdown-folder', 'either', ['zip']],
  ['notion', 'either', ['zip']],
  ['enex', 'file', ['enex']],
  ['roam', 'file', ['json']],
  ['bear', 'either', ['bearbk', 'textbundle', 'textpack', 'zip']],
  ['google-keep', 'either', ['zip']],
  ['csv', 'file', ['csv', 'tsv']],
];

export function emptyReport(over: Partial<ImportReport> = {}): ImportReport {
  return {
    sourceId: 'enex',
    folder: 'Imports/enex-2024-03-01',
    reportPath: 'Imports/enex-2024-03-01/Import report.md',
    startedAt: '2024-03-01T12:00:00Z',
    finishedAt: '2024-03-01T12:00:01Z',
    cancelled: false,
    notesCreated: 2,
    attachmentsCreated: 1,
    created: [],
    createdTruncated: false,
    skipped: [],
    failed: [],
    linksRewritten: 0,
    linksUnresolved: 0,
    warnings: [],
    ...over,
  };
}

export const importerMock: ImporterMockState = {
  sources: [],
  picked: '/mock/export.enex',
  preview: {
    notes: 2,
    attachments: 1,
    titles: ['Shopping', 'Meeting notes'],
    warnings: ['encrypted text was skipped'],
    targetFolder: 'Imports/enex-2024-03-01',
    columns: [],
    delimiter: '',
  },
  report: emptyReport(),
  runError: '',
  hold: false,
  previews: [],
  runs: [],
  cancelled: [],
  finish: () => undefined,
};

export function resetImporterMock(): void {
  importerMock.sources = SOURCES.map(([id, input, extensions]) => ({ id, input, extensions }));
  importerMock.picked = '/mock/export.enex';
  importerMock.preview = {
    notes: 2,
    attachments: 1,
    titles: ['Shopping', 'Meeting notes'],
    warnings: ['encrypted text was skipped'],
    targetFolder: 'Imports/enex-2024-03-01',
    columns: [],
    delimiter: '',
  };
  importerMock.report = emptyReport();
  importerMock.runError = '';
  importerMock.hold = false;
  importerMock.previews = [];
  importerMock.runs = [];
  importerMock.cancelled = [];
  importerMock.finish = () => undefined;
}

export function createImporterMock(emit: (name: string, payload: unknown) => void) {
  resetImporterMock();
  const done = (vaultId: string, cancelled = false): void => {
    const payload: ImportDonePayload = importerMock.runError
      ? { jobId: 'job-1', vaultId, ok: false, error: importerMock.runError, report: null }
      : {
          jobId: 'job-1',
          vaultId,
          ok: true,
          error: '',
          report: { ...importerMock.report, cancelled },
        };
    emit(Events.importerDone, payload);
  };
  return {
    ListSources: (): Promise<ImportSource[]> => Promise.resolve(importerMock.sources),
    Detect: (path: string): Promise<string[]> => {
      const l = path.toLowerCase();
      if (l.endsWith('.enex')) return Promise.resolve(['enex']);
      if (l.endsWith('.json')) return Promise.resolve(['roam']);
      if (l.endsWith('.csv')) return Promise.resolve(['csv']);
      return Promise.resolve(['markdown-folder']);
    },
    DefaultFolder: (id: string): Promise<string> => Promise.resolve(`Imports/${id}-2024-03-01`),
    PickFile: (): Promise<string> => Promise.resolve(importerMock.picked),
    Preview: (
      vaultId: string,
      sourceId: string,
      path: string,
      opts: ImportOptions,
    ): Promise<ImportPreview> => {
      importerMock.previews.push({ vaultId, sourceId, path, opts });
      return Promise.resolve(importerMock.preview);
    },
    Run: (
      vaultId: string,
      sourceId: string,
      path: string,
      opts: ImportOptions,
    ): Promise<string> => {
      importerMock.runs.push({ vaultId, sourceId, path, opts });
      const progress: ImportProgressPayload = {
        jobId: 'job-1',
        vaultId,
        done: 1,
        total: 2,
        current: 'Shopping.md',
      };
      setTimeout(() => {
        emit(Events.importerProgress, progress);
        if (importerMock.hold) importerMock.finish = () => done(vaultId);
        else done(vaultId);
      }, 0);
      return Promise.resolve('job-1');
    },
    Cancel: (jobId: string): Promise<void> => {
      importerMock.cancelled.push(jobId);
      const vaultId = importerMock.runs.at(-1)?.vaultId ?? '';
      setTimeout(() => done(vaultId, true), 0);
      return Promise.resolve();
    },
    Report: (): Promise<ImportReport> => Promise.resolve(importerMock.report),
  };
}
