// Which note editor is "the" editor right now: formatting commands act on the focused one. Editors
// register their NoteEditorHandle under their pane id; nobody outside the editor sees the engine.
import type { NoteEditorHandle } from './handle';

const editors = new Map<string, NoteEditorHandle>();
let active: string | null = null;

export function registerEditor(id: string, handle: NoteEditorHandle): void {
  editors.set(id, handle);
}

export function unregisterEditor(id: string, handle: NoteEditorHandle): void {
  if (editors.get(id) === handle) editors.delete(id);
  if (active === id && !editors.has(id)) active = null;
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
