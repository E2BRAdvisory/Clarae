// Where the view of a drawing goes. Only the types of Excalidraw are imported here, so the module
// stays out of the main bundle and its rules are tested without the editor.
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

/**
 * What "zoom to the selection" brings into view: the selected elements, or the whole drawing when
 * nothing is selected (a drawing that may not be changed never has a selection).
 */
export function zoomTargets<T extends { id: string; isDeleted?: boolean }>(
  elements: readonly T[],
  selected: readonly string[],
): T[] {
  const live = elements.filter((e) => !e.isDeleted);
  if (selected.length === 0) return live;
  const ids = new Set(selected);
  const picked = live.filter((e) => ids.has(e.id));
  return picked.length > 0 ? picked : live;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type ViewApi = Pick<ExcalidrawImperativeAPI, 'getSceneElements' | 'getAppState' | 'setViewport'>;

/** The margin Excalidraw leaves around what it fits, in px. */
const FIT_PADDING = 24;

/**
 * What Excalidraw's bottom bar covers of the canvas, in px of the canvas. Excalidraw measures its
 * own chrome for a fit (`offsets.ui`), but its tray layout — the one an editable drawing uses —
 * does not declare the bottom bar; undefined when there is none to add (the full layout, zen).
 */
export function bottomBarInset(host: Element | null, canvasHeight: number): number | undefined {
  const root = host?.querySelector('.excalidraw');
  const bar = root?.querySelector('.App-bottom-bar');
  if (!root || !bar) return undefined;
  const r = root.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  if (r.height === 0 || b.height === 0) return undefined;
  return Math.max(0, Math.round(((r.bottom - b.top) * canvasHeight) / r.height));
}

export interface FitOptions {
  /** The whole drawing, whatever is selected. */
  everything?: boolean;
  /** What covers the bottom of the canvas besides the chrome Excalidraw measures (bottomBarInset). */
  bottomInset?: number | undefined;
}

/** How a fit avoids the editor chrome: what Excalidraw measures, plus the bar it does not. */
export function fitOffsets(bottomInset?: number): { ui: true; bottom?: number } {
  return bottomInset === undefined ? { ui: true } : { ui: true, bottom: bottomInset + FIT_PADDING };
}

/** Fits the selection (or everything) in what the toolbar and the bottom bar leave free. */
export function zoomToSelection(api: ViewApi, opts: FitOptions = {}): void {
  const targets = zoomTargets(
    api.getSceneElements(),
    opts.everything ? [] : Object.keys(api.getAppState().selectedElementIds),
  );
  if (targets.length === 0) return;
  api.setViewport({
    target: targets,
    fit: 'contain',
    animation: !reducedMotion(),
    offsets: fitOffsets(opts.bottomInset),
  });
}
