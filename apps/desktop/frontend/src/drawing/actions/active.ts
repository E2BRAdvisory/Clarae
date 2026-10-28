// Which drawing editor the scene-action commands act on. The Excalidraw editor registers a
// controller while it is mounted; commands (palette, hotkeys, menus) reach it from here without
// importing Excalidraw, so this module stays out of the main bundle.
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
  /** Per-drawing settings stored in the file itself (`memobrain` key); null clears one. */
  setFileSetting(key: string, value: string | null): void;
  /** Opens a tool dialog of the editor; `editId` edits an existing element. */
  openTool(kind: ToolKind, editId?: string): void;
  /** Merges the shapes of a ".excalidrawlib" (its JSON text) into the library; returns how many. */
  importLibrary(json: string): Promise<number>;
  /** Starts the presentation; with frames it plays them as slides. */
  startSlideshow(): void;
}

export type ToolKind = 'latex' | 'mermaid' | 'tools' | 'describe';

let active: SceneController | null = null;

export function registerSceneController(c: SceneController): void {
  active = c;
}

export function unregisterSceneController(c: SceneController): void {
  if (active === c) active = null;
}

export function getSceneController(): SceneController | null {
  return active;
}
