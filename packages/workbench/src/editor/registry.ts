// Which note editor is "the" editor right now: formatting commands act on the focused one. Editors
// register their NoteEditorHandle under their pane id; nobody outside the editor sees the engine.
import type { NoteEditorHandle } from './handle';

const editors = new Map<string, NoteEditorHandle>();
const listeners = new Set<() => void>();
let version = 0;
const changed = (): void => {
  version++;
  listeners.forEach((l) => l());
};
let active: string | null = null;

export function registerEditor(id: string, handle: NoteEditorHandle): void {
  editors.set(id, handle);
  changed();
}

export function unregisterEditor(id: string, handle: NoteEditorHandle): void {
  if (editors.get(id) === handle) {
    editors.delete(id);
    changed();
  }
  if (active === id && !editors.has(id)) active = null;
}

/** Calls `listener` when an editor is registered or goes away (the engine of a pane changed). Returns the stop function. */
export function onEditorsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setActiveEditor(id: string): void {
  active = id;
}

export function getActiveEditor(): NoteEditorHandle | null {
  return (active && editors.get(active)) || null;
}

export function getEditor(id: string): NoteEditorHandle | null {
  return editors.get(id) ?? null;
}

/** A number that changes whenever an editor is registered or goes away (for `useSyncExternalStore`). */
export const editorsVersion = (): number => version;
