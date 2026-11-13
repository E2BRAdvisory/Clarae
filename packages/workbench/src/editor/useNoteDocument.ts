import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorCode } from '../app/api';
import { Events } from '../app/events';
import { registerNoteFlusher, reportFlush, writeRescueCopy } from '../workspaces/flush';
import { errorMessage } from '../util/errors';

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
  /** Hash of the file version the editor text is based on (the last load or successful write). */
  savedHash: () => string;
  /**
   * Call on every edit, with the text or a getter of it: the editor passes a getter, so a keystroke
   * in a large note does not copy the whole document; the text is built when a save, a flush or
   * `current` needs it.
   */
  edit: (text: string | (() => string)) => void;
  /**
   * Saves now, after any write in flight; resolves true when the file holds the editor's text,
   * false when the edits are still only in memory (conflict, write error).
   */
  flush: () => Promise<boolean>;
  /** Reloads from disk, discarding unsaved edits (the user's explicit choice). */
  reload: () => Promise<void>;
  /** Shows the file's new content if it changed on disk; unsaved edits are kept (as a conflict). */
  refresh: () => Promise<void>;
  /** Saves ignoring a conflict: the editor wins. Resolves true once written. */
  overwrite: () => Promise<boolean>;
}

/** Default autosave delay; drawings use a longer one (they are written whole). */
export const NOTE_DEBOUNCE_MS = 500;

/** Rounds of a flush when the text keeps changing while it is written. */
const FLUSH_ROUNDS = 5;
/** Overwrite attempts when the file keeps changing between reading its hash and writing. */
const OVERWRITE_ATTEMPTS = 3;
/** Re-reads of an external change when a write of ours landed meanwhile. */
const REFRESH_ATTEMPTS = 5;

type Outcome = 'saved' | 'dirty' | 'failed';

/**
 * Loads a note and keeps it saved. Writes carry the hash of the last read
 * (WriteNote expectedHash), so an external edit is detected instead of
 * overwritten; the user then chooses to reload or overwrite.
 *
 * Loads and writes run one at a time (a promise chain), so each write uses the hash the previous
 * one returned and two saves never race with the same stale hash. A generation counter, bumped by
 * every load and successful write, lets an external-change read that a write overtook be retried
 * instead of being taken for somebody else's edit.
 */
export function useNoteDocument(
  vaultId: string,
  path: string,
  debounceMs: number = NOTE_DEBOUNCE_MS,
): NoteDocument {
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
  /** The latest text, or a getter of it not called yet (see edit). */
  const latest = useRef<string | (() => string)>('');
  const textNow = useCallback((): string => {
    const v = latest.current;
    if (typeof v === 'string') return v;
    const text = v();
    if (latest.current === v) latest.current = text;
    return text;
  }, []);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const conflict = useRef(false);
  /** Every load and write, in order; replaced (new identity) by each job queued. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);
  /** The last load failed: the document shows an error until a load succeeds. */
  const failed = useRef(false);

  const enqueue = useCallback(<T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(job);
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  // A write of `text` landed with `newHash`.
  const accepted = useCallback(
    (newHash: string, text: string) => {
      hashRef.current = newHash;
      generation.current++;
      conflict.current = false;
      setHash(newHash);
      if (textNow() === text) {
        dirty.current = false;
        setSave('saved');
      } else {
        setSave('dirty'); // edited again while saving
      }
    },
    [textNow],
  );

  const rejected = useCallback((e: unknown) => {
    const code = errorCode(e);
    if (code === 'conflict' || code === 'not-found') {
      conflict.current = true;
      setSave('conflict');
    } else {
      setState((s) => ({ ...s, error: errorMessage(e) }));
      setSave('error');
    }
  }, []);

  const load = useCallback(
    () =>
      enqueue(async () => {
        try {
          const note = await api.vault.readNote(vaultId, path);
          hashRef.current = note.hash;
          latest.current = note.content;
          dirty.current = false;
          conflict.current = false;
          generation.current++;
          failed.current = false;
          setHash(note.hash);
          setSave('saved');
          setState((s) => ({
            status: 'ready',
            content: note.content,
            version: s.version + 1,
            error: '',
          }));
        } catch (e) {
          failed.current = true;
          setState((s) => ({ ...s, status: 'error', error: errorMessage(e) }));
        }
      }),
    [vaultId, path, enqueue],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // One write of the latest text with the latest hash, after whatever is in flight.
  const saveOnce = useCallback(
    (): Promise<Outcome> =>
      enqueue(async (): Promise<Outcome> => {
        if (!dirty.current) return 'saved';
        // A conflict waits for the user; a document that never loaded has no base to write over.
        if (conflict.current || hashRef.current === '') return 'failed';
        const text = textNow();
        setSave('saving');
        try {
          const res = await api.vault.writeNote(vaultId, path, text, hashRef.current);
          accepted(res.hash, text);
          return dirty.current ? 'dirty' : 'saved';
        } catch (e) {
          rejected(e);
          return 'failed';
        }
      }),
    [vaultId, path, enqueue, accepted, rejected, textNow],
  );

  const edit = useCallback(
    (text: string | (() => string)) => {
      latest.current = text;
      dirty.current = true;
      setSave((s) => (s === 'conflict' ? s : 'dirty'));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveOnce(), debounceMs);
    },
    [saveOnce, debounceMs],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    for (let round = 0; round < FLUSH_ROUNDS; round++) {
      clearTimeout(timer.current);
      const outcome = await saveOnce();
      if (outcome !== 'dirty') return outcome === 'saved';
    }
    return !dirty.current;
  }, [saveOnce]);

  // The Go binding reads an empty expected hash as "create", so overwriting means writing over the
  // hash the file has now (or creating it again when it is gone), retried if it keeps changing.
  const overwrite = useCallback(
    (): Promise<boolean> =>
      enqueue(async (): Promise<boolean> => {
        clearTimeout(timer.current);
        const text = textNow();
        setSave('saving');
        for (let attempt = 0; attempt < OVERWRITE_ATTEMPTS; attempt++) {
          let base = '';
          try {
            base = (await api.vault.readNote(vaultId, path)).hash;
          } catch (e) {
            if (errorCode(e) !== 'not-found') {
              rejected(e);
              return false;
            }
          }
          try {
            const res = await api.vault.writeNote(vaultId, path, text, base);
            accepted(res.hash, text);
            return true;
          } catch (e) {
            const code = errorCode(e);
            if (code !== 'conflict' && code !== 'exists' && code !== 'not-found') {
              rejected(e);
              return false;
            }
          }
        }
        conflict.current = true;
        setSave('conflict');
        return false;
      }),
    [vaultId, path, enqueue, accepted, rejected, textNow],
  );

  const refresh = useCallback(async (): Promise<void> => {
    // A document that could not be loaded tries again: the file may be readable now.
    if (failed.current) return load();
    for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
      const before = chain.current;
      await before; // a write of ours in flight lands first
      const gen = generation.current;
      let note;
      try {
        note = await api.vault.readNote(vaultId, path);
      } catch {
        return; // deleted or renamed meanwhile: the tab is closed or retargeted by the store
      }
      // A load or write was queued or landed while reading: the read may predate it.
      if (chain.current !== before || gen !== generation.current) continue;
      if (note.hash === hashRef.current) return;
      if (!dirty.current) {
        // Nothing unsaved: just show the new content.
        hashRef.current = note.hash;
        latest.current = note.content;
        generation.current++;
        setHash(note.hash);
        setState((s) => ({ ...s, content: note.content, version: s.version + 1 }));
      } else {
        conflict.current = true;
        setSave('conflict');
      }
      return;
    }
  }, [vaultId, path, load]);

  // Keeps edits that cannot be saved in the file in a copy next to it.
  const rescue = useCallback(
    (): Promise<string | null> =>
      enqueue(async () => {
        if (!dirty.current) return null;
        const text = textNow();
        const copy = await writeRescueCopy(vaultId, path, text);
        if (textNow() === text) dirty.current = false;
        return copy;
      }),
    [vaultId, path, enqueue, textNow],
  );

  // Lets "load workspace", closing the vault, renaming and quitting write every pending edit first.
  useEffect(
    () => registerNoteFlusher({ vaultId, path, flush, rescue, dirty: () => dirty.current }),
    [vaultId, path, flush, rescue],
  );

  // Save pending edits when the note is closed: after the write in flight, with the latest hash.
  // What cannot be saved in the file (a conflict, an error) goes to a copy, and the user is told.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (!dirty.current) return;
      void (async () => {
        if (await flush()) return;
        if (!dirty.current) return;
        try {
          const copy = await rescue();
          if (copy) await reportFlush({ failed: [], rescued: [copy] });
        } catch (e) {
          console.error(`clarae: unsaved edits of ${path} could not be written`, e);
          await reportFlush({ failed: [path], rescued: [] });
        }
      })();
    },
    [path, flush, rescue],
  );

  // External change of this file.
  useEffect(() => {
    return api.on(Events.vaultFileChanged, (p) => {
      if (p.vaultId !== vaultId || !p.paths.includes(path)) return;
      void refresh();
    });
  }, [vaultId, path, refresh]);

  // Coming back to the window retries a document that could not be loaded (a transient I/O
  // error, a file being written by the sync, the core restarting on the web).
  useEffect(() => {
    const onFocus = (): void => {
      if (failed.current) void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  return {
    status: state.status,
    content: state.content,
    version: state.version,
    hash,
    save,
    error: state.error,
    current: textNow,
    savedHash: () => hashRef.current,
    edit,
    flush,
    reload: load,
    refresh,
    overwrite,
  };
}
