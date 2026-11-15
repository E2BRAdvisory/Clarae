// The graph is not a file: its tab uses a pseudo path in the workspace layout, so it is
// persisted in .clarae/workspace.json like any other tab. "graph://global" is the whole vault,
// "graph://local/<note path>" the neighbourhood of one note.
const GLOBAL = 'graph://global';
const LOCAL = 'graph://local/';

export const globalGraphPath = (): string => GLOBAL;
export const localGraphPath = (notePath: string): string => LOCAL + notePath;

/** Files that hold links, so a local graph can be centred on them. */
const LINKED = /\.(md|marp|excalidraw|canvas)$/i;

/** Whether a local graph can be centred on a file: a note, a presentation, a drawing, a canvas. */
export const canCenterGraph = (path: string): boolean => LINKED.test(path);

export function isGraphPath(path: string): boolean {
  return path === GLOBAL || path.startsWith(LOCAL);
}

/** The file a local graph is centred on; null for the global graph or a non-graph path. */
export function graphCenter(path: string): string | null {
  return path.startsWith(LOCAL) ? path.slice(LOCAL.length) : null;
}

/** Tab title key and parameters for a graph path. */
export function graphTitle(path: string): { key: string; name: string } {
  const c = graphCenter(path);
  if (c === null) return { key: 'graph.title', name: '' };
  const base = c.slice(c.lastIndexOf('/') + 1).replace(LINKED, '');
  return { key: 'graph.localTitle', name: base };
}
