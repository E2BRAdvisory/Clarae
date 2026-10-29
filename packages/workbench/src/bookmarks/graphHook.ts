// Extension point between bookmarks and the graph view (built separately).
//
// The graph module registers, once, at startup:
//
//   registerGraphBookmarks({
//     open: (options) => { /* show the graph with these stored options */ },
//     capture: () => ({ ...current view/query parameters }) | null, // optional
//   });
//
// "graph" bookmarks store `options` as an opaque JSON object: bookmarks never
// interpret it. Until a module registers, activating a graph bookmark shows a
// notice and "Bookmark current graph" is disabled.

export interface GraphBookmarkProvider {
  /** Shows the graph view configured by the stored options. */
  open(options: Record<string, unknown>): void;
  /** Current view/query parameters of the graph, or null when no graph is open. */
  capture?(): Record<string, unknown> | null;
}

let provider: GraphBookmarkProvider | null = null;

/** Registers the graph module (null unregisters). */
export function registerGraphBookmarks(p: GraphBookmarkProvider | null): void {
  provider = p;
}

export const hasGraphBookmarks = (): boolean => provider !== null;

/** Options to store for "Bookmark current graph", or null when unavailable. */
export function captureGraphOptions(): Record<string, unknown> | null {
  return provider?.capture?.() ?? null;
}

/** Opens a graph bookmark; false when no graph module is registered. */
export function openGraph(options: Record<string, unknown>): boolean {
  if (!provider) return false;
  provider.open(options);
  return true;
}
