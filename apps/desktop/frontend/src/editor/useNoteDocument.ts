import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorCode } from '../app/api';
import { Events, type FileChangedPayload } from '../app/events';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

export interface NoteDocument {
  status: 'loading' | 'ready' | 'error';
  /** Content as of the last load/save; the editor owns edits in between (see `current`). */
  content: string;
  /** Bumped when content was replaced from disk, so the editor reloads it. */
  version: number;
  hash: string;
  save: SaveState;
  error: string;
  /** The latest text, including edits not yet saved. */
  current: () => string;
  /** Call on every edit. */
  edit: (text: string) => void;
  /** Saves now; resolves once the write finished (or immediately when clean). */
  flush: () => Promise<void>;
  /** Reloads from disk, discarding unsaved edits. */
  reload: () => Promise<void>;
  /** Saves ignoring a conflict: the editor wins. */
  overwrite: () => Promise<void>;
}

const DEBOUNCE_MS = 500;

/**
 * Loads a note and keeps it saved. Writes carry the hash of the last read
 * (WriteNote expectedHash), so an external edit is detected instead of
 * overwritten; the user then chooses to reload or overwrite.
 */
export function useNoteDocument(vaultId: string, path: string): NoteDocument {
  const [state, setState] = useState<{
    status: NoteDocument['status'];
    content: string;
    version: number;
    error: string;
  }>({
    status: 'loading',
    content: '',
    version: 0,
    error: '',
  });
  const [save, setSave] = useState<SaveState>('saved');
  const [hash, setHash] = useState('');
  const hashRef = useRef('');
  const latest = useRef('');
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void> | null>(null);
  const conflict = useRef(false);

  const load = useCallback(async () => {
    try {
      const note = await api.vault.readNote(vaultId, path);
      hashRef.current = note.hash;
      latest.current = note.content;
      dirty.current = false;
      conflict.current = false;
      setHash(note.hash);
      setSave('saved');
      setState((s) => ({
        status: 'ready',
        content: note.content,
        version: s.version + 1,
        error: '',
      }));
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', error: String(e) }));
    }
  }, [vaultId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const doSave = useCallback(
    async (force: boolean): Promise<void> => {
      if (saving.current) await saving.current;
      if (!dirty.current && !force) return;
      if (conflict.current && !force) return;
      const text = latest.current;
      setSave('saving');
      const run = (async () => {
        try {
          const res = await api.vault.writeNote(vaultId, path, text, force ? '' : hashRef.current);
          hashRef.current = res.hash;
          setHash(res.hash);
          conflict.current = false;
          if (latest.current === text) {
            dirty.current = false;
            setSave('saved');
          } else {
            setSave('dirty'); // edited again while saving
          }
        } catch (e) {
          if (errorCode(e) === 'conflict') {
            conflict.current = true;
            setSave('conflict');
          } else {
            setState((s) => ({ ...s, error: String(e) }));
            setSave('error');
          }
        }
      })();
      saving.current = run;
      await run;
      saving.current = null;
    },
    [vaultId, path],
  );

  const edit = useCallback(
    (text: string) => {
      latest.current = text;
      dirty.current = true;
      setSave((s) => (s === 'conflict' ? s : 'dirty'));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void doSave(false), DEBOUNCE_MS);
    },
    [doSave],
  );

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    await doSave(false);
  }, [doSave]);

  // Save pending edits when the note is closed.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (dirty.current && !conflict.current)
        void api.vault
          .writeNote(vaultId, path, latest.current, hashRef.current)
          .catch(() => undefined);
    },
    [vaultId, path],
  );

  // External change of this file.
  useEffect(() => {
    return api.on<FileChangedPayload>(Events.vaultFileChanged, (p) => {
      if (p.vaultId !== vaultId || !p.paths.includes(path)) return;
      void api.vault
        .readNote(vaultId, path)
        .then((note) => {
          if (note.hash === hashRef.current) return;
          if (!dirty.current) {
            // Nothing unsaved: just show the new content.
            hashRef.current = note.hash;
            latest.current = note.content;
            setHash(note.hash);
            setState((s) => ({ ...s, content: note.content, version: s.version + 1 }));
          } else {
            conflict.current = true;
            setSave('conflict');
          }
        })
        .catch(() => undefined); // deleted or renamed meanwhile: the tab is closed or retargeted by the store
    });
  }, [vaultId, path]);

  return {
    status: state.status,
    content: state.content,
    version: state.version,
    hash,
    save,
    error: state.error,
    current: () => latest.current,
    edit,
    flush,
    reload: load,
    overwrite: () => doSave(true),
  };
}
