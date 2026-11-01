// Open documents (editor/useNoteDocument.ts) register here, so an operation that makes them go
// away (loading a workspace, closing or switching the vault, renaming, quitting the app, leaving
// the Web UI) can write every pending edit first, and learn which edits could not be written.
import i18next from 'i18next';
import { api, errorCode } from '../app/api';
import { dialog } from '../ui/dialogs';

/** What a document offers to the operations that flush it. */
export interface OpenDocument {
  vaultId: string;
  path: string;
  /** Saves the pending edits; resolves true when the file holds the editor's text. */
  flush(): Promise<boolean>;
  /** Writes the pending edits to a copy next to the file; resolves its path (null: nothing to keep). */
  rescue(): Promise<string | null>;
  /** The document has edits that are not on disk. */
  dirty(): boolean;
}

/** Outcome of flushAllNotes. */
export interface FlushReport {
  /** Paths whose edits are still only in memory (conflict, write error, failed rescue). */
  failed: string[];
  /** Copies written for edits that could not be saved in their own file (rescue mode). */
  rescued: string[];
}

const docs = new Set<OpenDocument>();

/**
 * Registers an open document (or a bare flush function, which counts as always saved); returns
 * the function that unregisters it.
 */
export function registerNoteFlusher(doc: OpenDocument | (() => Promise<unknown>)): () => void {
  const entry: OpenDocument =
    typeof doc === 'function'
      ? {
          vaultId: '',
          path: '',
          flush: async () => {
            await doc();
            return true;
          },
          rescue: () => Promise.resolve(null),
          dirty: () => false,
        }
      : doc;
  docs.add(entry);
  return () => {
    docs.delete(entry);
  };
}

/** Some open document has edits that are not on disk yet. */
export function hasUnsavedNotes(): boolean {
  return [...docs].some((d) => d.dirty());
}

/**
 * Saves the pending edits of every open document. With `rescue`, the edits a document cannot save
 * in its own file (a conflict, a write error) are written to a copy next to it, so nothing is lost
 * when the document goes away (D-04).
 */
export async function flushAllNotes(opts: { rescue?: boolean } = {}): Promise<FlushReport> {
  const report: FlushReport = { failed: [], rescued: [] };
  await Promise.all(
    [...docs].map(async (d) => {
      const ok = await d.flush().catch(() => false);
      if (ok || !d.dirty()) return;
      if (opts.rescue) {
        const copy = await d.rescue().catch(() => null);
        if (copy) return void report.rescued.push(copy);
        if (!d.dirty()) return;
      }
      report.failed.push(d.path);
    }),
  );
  return report;
}

/** Tells the user where rescued edits went and which edits could not be written at all. */
export async function reportFlush(report: FlushReport): Promise<void> {
  if (report.rescued.length)
    await dialog.alert(
      i18next.t('editor.rescuedTitle'),
      i18next.t('editor.rescued', { paths: report.rescued.join(', ') }),
    );
  if (report.failed.length)
    await dialog.alert(
      i18next.t('editor.notSavedTitle'),
      i18next.t('editor.notSavedList', { paths: report.failed.join(', ') }),
    );
}

/**
 * Before the open documents go away with the vault (close, switch): saves them, rescues what
 * cannot be saved and tells the user. Resolves false when some edits are still only in memory:
 * the caller must then keep the vault open.
 */
export async function settleNotes(): Promise<boolean> {
  const report = await flushAllNotes({ rescue: true });
  await reportFlush(report);
  return report.failed.length === 0;
}

/** Resolves with `p`, or with undefined after `ms` (an exit must not hang on a stuck write). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => resolve(v),
      () => resolve(undefined),
    ).finally(() => clearTimeout(timer));
  });
}

/** "Note.md" -> "Note (unsaved 2026-11-01 10-22).md", next to it; the extension is kept. */
export function rescuePath(path: string, at: Date, n = 0): string {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = path.slice(slash + 1);
  const compound = /\.excalidraw\.md$/i.exec(base);
  const dot = base.lastIndexOf('.');
  const ext = compound ? compound[0] : dot > 0 ? base.slice(dot) : '';
  const stem = base.slice(0, base.length - ext.length);
  const pad = (v: number): string => String(v).padStart(2, '0');
  const time = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`;
  const name = i18next.t('editor.rescueName', { name: stem, time });
  return `${dir}${name}${n ? ` ${n}` : ''}${ext}`;
}

/** Writes `text` to a new copy next to `path` (never over an existing file); resolves its path. */
export async function writeRescueCopy(
  vaultId: string,
  path: string,
  text: string,
): Promise<string> {
  const at = new Date();
  let last: unknown = null;
  for (let n = 0; n < 20; n++) {
    const copy = rescuePath(path, at, n);
    try {
      await api.vault.writeNote(vaultId, copy, text, ''); // '' = create: fails if the copy exists
      return copy;
    } catch (e) {
      last = e;
      if (errorCode(e) !== 'exists') break;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
