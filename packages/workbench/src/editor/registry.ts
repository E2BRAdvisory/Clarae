// Which CodeMirror view is "the" editor right now: formatting commands act on
// the focused one. Views register themselves under their pane id.
import type { EditorView } from '@codemirror/view';

const views = new Map<string, EditorView>();
let active: string | null = null;

export function registerEditor(id: string, view: EditorView): void {
  views.set(id, view);
}

export function unregisterEditor(id: string, view: EditorView): void {
  if (views.get(id) === view) views.delete(id);
  if (active === id && !views.has(id)) active = null;
}

export function setActiveEditor(id: string): void {
  active = id;
}

export function getActiveEditor(): EditorView | null {
  return (active && views.get(active)) || null;
}

export function getEditor(id: string): EditorView | null {
  return views.get(id) ?? null;
}
