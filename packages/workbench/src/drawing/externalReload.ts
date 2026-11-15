// What a newer version of the file (sync, an external edit, another pane) changes in an open
// editor besides its elements. Pure: nothing here imports Excalidraw.

/**
 * The keys of `appState` Excalidraw writes to the file: they belong to the drawing. Everything
 * else in the editor's state (scroll, zoom, selection, the tool in hand) belongs to the view and
 * is never replaced by a file.
 */
const DOCUMENT_STATE = [
  'viewBackgroundColor',
  'gridSize',
  'gridStep',
  'gridModeEnabled',
  'lockedMultiSelections',
] as const;

/** The part of a file's `appState` an open editor takes over: the document keys it holds. */
export function documentAppState(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DOCUMENT_STATE) if (key in appState) out[key] = appState[key];
  return out;
}
