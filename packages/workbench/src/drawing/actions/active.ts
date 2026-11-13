// Which drawing editor the scene-action commands act on. The Excalidraw editor registers a
// controller while it is mounted; commands (palette, hotkeys, menus) reach it from here without
// importing Excalidraw, so this module stays out of the main bundle.
import { selectActivePath, useAppStore } from '../../state/store';
import type { SceneContext, ScenePatch, SceneFile } from './types';

export interface SceneController {
  vaultId: string;
  /** Current elements and selection. */
  context(): SceneContext;
  /** Applies a patch to the open scene (the editor's own autosave then writes the file). */
  apply(patch: ScenePatch): void;
  /** False for a locked/read-only vault or while presenting. */
  canEdit(): boolean;
  /** Center of what is on screen, in scene coordinates. */
  viewportCenter(): { x: number; y: number };
  /** The stroke color new elements get (so inserted formulas match the drawing). */
  defaultColor(): string;
  /**
   * Writes the drawing now and resolves when it is saved. Excalidraw reports edits
   * asynchronously, so a command that is about to leave the drawing (change tab) must call this.
   */
  save(): Promise<void>;
  /** The vault path of the open drawing. */
  drawingPath: string;
  /** The binary files (images) of the drawing, by id. */
  files(): Record<string, SceneFile>;
  /** Per-drawing settings stored in the file itself (`clarae` key); null clears one. */
  setFileSetting(key: string, value: string | null): void;
  /** Opens a tool dialog of the editor; `editId` edits an existing element. */
  openTool(kind: ToolKind, editId?: string): void;
  /** Merges the shapes of a ".excalidrawlib" (its JSON text) into the library; returns how many. */
  importLibrary(json: string): Promise<number>;
  /** Starts the presentation; with frames it plays them as slides, from `fromId` if given. */
  startSlideshow(fromId?: string): void;
  /** SVG data URL of one frame (a slide thumbnail); empty when the frame is gone. */
  slideThumbnail(id: string, width?: number): Promise<string>;
  /** Brings a frame into view. */
  showFrame(id: string): void;
  /** Prints the included slides, one per page (the system dialog offers "Save as PDF"). */
  printSlides(): Promise<void>;
  /** Opens the export dialog with the format preselected. */
  openExport(format: 'png' | 'svg'): void;
  /** Prints the whole drawing (the system dialog offers "Save as PDF"). */
  printDrawing(): Promise<void>;
  /** The drawing's own settings (`clarae` key of the file). */
  fileSettings(): Record<string, unknown>;
}

export type ToolKind = 'latex' | 'mermaid' | 'tools' | 'describe';

/** The editors that are mounted, in the order they registered (split panes can show several). */
const controllers: SceneController[] = [];
const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((l) => l());

export function registerSceneController(c: SceneController): void {
  const at = controllers.indexOf(c);
  if (at >= 0) controllers.splice(at, 1);
  controllers.push(c);
  changed();
}

export function unregisterSceneController(c: SceneController): void {
  const at = controllers.indexOf(c);
  if (at < 0) return;
  controllers.splice(at, 1);
  changed();
}

/** Calls `listener` when a drawing editor registers or goes away (the ribbon enables its buttons). */
export function subscribeSceneController(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The editor of the drawing at `path` (the last one registered when a drawing is shown twice); null
 * when it is not open. Without a path: the editor of the active tab's drawing, else (a note is in
 * focus) the one that registered last.
 */
export function getSceneController(path?: string | null): SceneController | null {
  const of = (p: string | null): SceneController | null =>
    p === null ? null : ([...controllers].reverse().find((c) => c.drawingPath === p) ?? null);
  if (path !== undefined) return of(path);
  return (
    of(selectActivePath(useAppStore.getState())) ?? controllers[controllers.length - 1] ?? null
  );
}
