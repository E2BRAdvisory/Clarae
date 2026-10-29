// Scene actions (the native counterpart of the Obsidian Excalidraw script library). Every action
// is a pure function from the current selection to a patch, so it is testable without Excalidraw
// and the merge by element id (shared/go/merge/jsonid.go) keeps working: a patch never touches
// anything but `elements`.

/** The subset of an Excalidraw element the actions read and write. */
export interface SceneElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export interface SceneContext {
  /** Every element of the scene, deleted ones included. */
  elements: readonly SceneElement[];
  /** Ids of the selected elements. */
  selected: readonly string[];
  /** Center of what is on screen: where generators put what they create. */
  origin?: { x: number; y: number };
  /** Answers to the action's `params`, by key. */
  params?: Readonly<Record<string, number>>;
}

/** A number the action asks the user for before it runs (title: i18n `drawing.params.<key>`). */
export interface ParamSpec {
  key: string;
  default: number | ((ctx: SceneContext) => number);
  min?: number;
  /** A closed set of values: asked with a picker instead of a free number. */
  options?: readonly { value: number; label?: string; labelKey?: string }[];
}

export interface ScenePatch {
  /** Property changes by element id. */
  update?: Record<string, Record<string, unknown>>;
  /** Brand new elements, appended on top. */
  add?: SceneElement[];
  /** Ids to mark as deleted (never removed: deletions must win the merge). */
  remove?: string[];
  /** Binary files (images) the new elements refer to, by file id. */
  files?: Record<string, SceneFile>;
  /** Changes to what is shown, not to the drawing: zoom, grid, selection, default styles. */
  view?: ViewPatch;
}

export interface ViewPatch {
  /** Ids to bring into view (fit the viewport). */
  zoomTo?: string[];
  /** Ids to select (replaces the selection). */
  select?: string[];
  /** Flips the grid on or off. */
  toggleGrid?: boolean;
  /** Editor state to set (grid size, the styles new elements get, ...). */
  appState?: Record<string, unknown>;
  /** Excalidraw tool to activate (`freedraw`, `laser`, `selection`, ...). */
  tool?: string;
}

/** An entry of a drawing's `files`. */
export interface SceneFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export interface SceneAction {
  /** Command id suffix: the command is `drawing:<id>`, its title `commands.drawing_<id>`. */
  id: string;
  group: 'layout' | 'style' | 'shapes' | 'arrows' | 'text' | 'links' | 'generators' | 'view';
  /** Minimum selected elements for the action to be enabled. */
  needs: number;
  /** Asked, in order, before `run`; answers arrive in `ctx.params`. */
  params?: readonly ParamSpec[];
  run(ctx: SceneContext): ScenePatch;
}

export function selectedElements(ctx: SceneContext): SceneElement[] {
  const set = new Set(ctx.selected);
  return ctx.elements.filter((e) => set.has(e.id) && !e.isDeleted);
}
