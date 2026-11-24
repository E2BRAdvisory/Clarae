// A template applied to an open drawing: the elements of the template join the scene, centered on
// what is on screen, as one undo step (ADR-0068). No import of Excalidraw here.
import { api } from '../app/api';
import { getSceneController } from './actions/active';
import { boundsOf, center, cloneScene } from './actions/factory';
import type { SceneElement, SceneFile, ScenePatch } from './actions/types';
import { parseScene } from './scene';

/**
 * The patch that adds the drawing `text` to a scene, centered on `at`; null when the text is not a
 * drawing or holds nothing. Only the pictures its elements use come along.
 */
export function templatePatch(text: string, at: { x: number; y: number }): ScenePatch | null {
  let scene;
  try {
    scene = parseScene(text);
  } catch {
    return null;
  }
  const live = (scene.elements as unknown as SceneElement[]).filter(
    (e) => !e.isDeleted && typeof e.id === 'string' && e.type !== 'selection',
  );
  const box = boundsOf(live);
  if (!box) return null;
  const c = center(box);
  const add = cloneScene(live, at.x - c.x, at.y - c.y);
  const files: Record<string, SceneFile> = {};
  for (const e of live) {
    const id = e['fileId'];
    const f = typeof id === 'string' ? (scene.files[id] as SceneFile | undefined) : undefined;
    if (f && typeof id === 'string') files[id] = f;
  }
  return { add, files, view: { select: add.map((e) => e.id) } };
}

/** Adds the template `ref` to the drawing in focus; false when the template holds nothing to add. */
export async function applyDrawingTemplate(ref: string): Promise<boolean> {
  const before = getSceneController();
  if (!before?.canEdit()) return true;
  const text = await api.templates.expand(before.vaultId, ref, '', 'en');
  const c = getSceneController(before.drawingPath); // the editor may have gone meanwhile
  if (!c?.canEdit()) return true;
  const patch = templatePatch(text, c.viewportCenter());
  if (!patch) return false;
  c.apply(patch);
  return true;
}
