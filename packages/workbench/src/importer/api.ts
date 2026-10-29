// Typed facade over the ImporterAPI bindings (wailsjs is generated, never edited).
import * as ImporterAPI from '../../wailsjs/go/app/ImporterAPI';
import type { importer } from '../../wailsjs/go/models';

type Plain<T> = Omit<T, 'convertValues'>;

export type ImportOptions = Plain<importer.Options>;
export type ImportPreview = Plain<importer.Preview>;
export type ImportReport = Plain<importer.Report>;
export type ImportItem = Plain<importer.Item>;
export type ImportSource = Plain<importer.SourceInfo>;
export type CsvOptions = Plain<importer.CSVOptions>;

export const importerApi = {
  listSources: (): Promise<ImportSource[]> => ImporterAPI.ListSources(),
  detect: (path: string): Promise<string[]> => ImporterAPI.Detect(path),
  defaultFolder: (sourceId: string): Promise<string> => ImporterAPI.DefaultFolder(sourceId),
  pickFile: (title: string, extensions: string[]): Promise<string> =>
    ImporterAPI.PickFile(title, extensions),
  preview: (
    vaultId: string,
    sourceId: string,
    path: string,
    opts: ImportOptions,
  ): Promise<ImportPreview> =>
    ImporterAPI.Preview(vaultId, sourceId, path, opts as importer.Options),
  run: (vaultId: string, sourceId: string, path: string, opts: ImportOptions): Promise<string> =>
    ImporterAPI.Run(vaultId, sourceId, path, opts as importer.Options),
  cancel: (jobId: string): Promise<void> => ImporterAPI.Cancel(jobId),
  report: (jobId: string): Promise<ImportReport> => ImporterAPI.Report(jobId),
};
