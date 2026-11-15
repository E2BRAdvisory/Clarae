// When the automatic export of a drawing runs. Drawing the PNG/SVG variants takes the main
// thread for a while, and a drawing being worked on is saved every couple of seconds: the export
// waits for a pause in the saves, and runs at once when the drawing is closed.

/** How long after the last save the export runs. */
export const AUTO_EXPORT_QUIET_MS = 15_000;

export interface AutoExporter<T> {
  /**
   * The drawing was saved. `key` names what an export of it would show (the scene and the export
   * settings): a key already exported is not exported again. `job` is what to draw.
   */
  saved(key: string, job: T): void;
  /** Exports now what is waiting (the drawing closes, the app flushes); resolves when done. */
  flush(): Promise<void>;
  /** Forgets what is waiting (the export was turned off). */
  cancel(): void;
  /** An export is waiting for the pause. */
  waiting(): boolean;
}

/**
 * `run` draws and writes one job; it resolves true when everything was written. A job that fails
 * is not remembered as exported, so the next save of the same scene tries again.
 */
export function createAutoExporter<T>(
  run: (job: T) => Promise<boolean>,
  quietMs: number = AUTO_EXPORT_QUIET_MS,
): AutoExporter<T> {
  let next: { key: string; job: T } | null = null;
  let exported = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Exports run one at a time, in order. */
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    const due = next;
    next = null;
    if (!due) return chain;
    chain = chain.then(async () => {
      if (due.key === exported) return;
      const ok = await run(due.job).catch(() => false);
      if (ok) exported = due.key;
    });
    return chain;
  };

  return {
    saved(key, job) {
      clearTimeout(timer);
      if (key === exported) {
        next = null; // back to what the files already show (an undo, a setting put back)
        return;
      }
      next = { key, job };
      timer = setTimeout(() => void flush(), quietMs);
    },
    flush,
    cancel() {
      clearTimeout(timer);
      next = null;
    },
    waiting: () => next !== null,
  };
}
