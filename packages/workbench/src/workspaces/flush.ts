// Open notes register a flush function here (editor/useNoteDocument.ts), so an
// operation that replaces the whole layout (loading a workspace) can write every
// pending edit before the views go away.
const flushers = new Set<() => Promise<void>>();

/** Registers a flusher; returns the function that unregisters it. */
export function registerNoteFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/** Saves the pending edits of every open note. */
export async function flushAllNotes(): Promise<void> {
  await Promise.all([...flushers].map((f) => f().catch(() => undefined)));
}
