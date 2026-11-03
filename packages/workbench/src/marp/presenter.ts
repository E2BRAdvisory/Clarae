// The open presentation previews, by file: the `marp:present` command starts the one of the tab
// in focus (its preview owns the slides already rendered).
const presenters = new Map<string, () => void>();

/** Registers the preview of a .marp file; returns its unregistration. */
export function registerPresenter(path: string, present: () => void): () => void {
  presenters.set(path, present);
  return () => {
    if (presenters.get(path) === present) presenters.delete(path);
  };
}

/** Starts presenting the file at path; false when no preview of it is open. */
export function present(path: string): boolean {
  const p = presenters.get(path);
  p?.();
  return !!p;
}
