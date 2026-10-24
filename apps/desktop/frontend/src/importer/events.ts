// Events of the importer (mirror of internal/app/bindings_importer.go).
import type { ImportReport } from './api';

export const ImporterEvents = {
  progress: 'importer:progress',
  done: 'importer:done',
} as const;

export interface ImportProgressPayload {
  jobId: string;
  vaultId: string;
  done: number;
  total: number;
  current: string;
}

export interface ImportDonePayload {
  jobId: string;
  vaultId: string;
  ok: boolean;
  error: string;
  report: ImportReport | null;
}
