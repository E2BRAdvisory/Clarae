// "Deconstruct selected elements into a new drawing": the selection (with the labels of its
// containers and the images it uses) becomes its own .excalidraw file, and leaves this one.
import type { SceneContext, SceneElement, SceneFile } from '../actions/types';
import { selectedElements } from '../actions/types';

export interface Deconstructed {
  /** The new drawing, as JSON. */
  json: string;
  /** Ids to remove from the source drawing. */
  ids: string[];
}

export function deconstruct(
  ctx: SceneContext,
  files: Readonly<Record<string, SceneFile>>,
  background = '#ffffff',
): Deconstructed | null {
  const picked = selectedElements(ctx);
  if (picked.length === 0) return null;
  const ids = new Set(picked.map((e) => e.id));
  // Labels follow their container.
  for (const e of ctx.elements)
    if (
      e.type === 'text' &&
      typeof e.containerId === 'string' &&
      ids.has(e.containerId) &&
      !e.isDeleted
    )
      ids.add(e.id);
  const elements = ctx.elements
    .filter((e) => ids.has(e.id) && !e.isDeleted)
    .map((e): SceneElement => ({
      ...e,
      // Bindings to elements that stay behind would dangle in the new file.
      boundElements: Array.isArray(e.boundElements)
        ? (e.boundElements as { id: string }[]).filter((b) => ids.has(b.id))
        : e.boundElements,
      startBinding: bound(e.startBinding, ids),
      endBinding: bound(e.endBinding, ids),
      frameId: typeof e.frameId === 'string' && ids.has(e.frameId) ? e.frameId : null,
    }));
  const used: Record<string, SceneFile> = {};
  for (const e of elements) {
    const id = typeof e.fileId === 'string' ? e.fileId : null;
    const f = id ? files[id] : undefined;
    if (id && f) used[id] = f;
  }
  const json = JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'clarae',
      elements,
      appState: { gridSize: null, viewBackgroundColor: background },
      files: used,
    },
    null,
    2,
  );
  return { json, ids: elements.map((e) => e.id) };
}

function bound(b: unknown, ids: Set<string>): unknown {
  const id = (b as { elementId?: unknown } | null)?.elementId;
  return typeof id === 'string' && ids.has(id) ? b : null;
}
