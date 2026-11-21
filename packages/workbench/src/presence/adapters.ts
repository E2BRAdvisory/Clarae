// What a position of the document means on the screen, per kind of view (ADR-0065). Each adapter has both
// directions: `toPos` turns the pointer into a position of the document to send, `place` turns the position
// of somebody else into a place in the cursor layer to draw. What travels is always relative to the document (a
// line and a column, a point of the scene or of the board), never screen pixels.
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { PresencePos } from '../app/api';
import type { NoteEditorHandle } from '../editor/handle';
import type { LayerPoint } from './LiveCursorsOverlay';
import type { PointerLike } from './useCursorSender';

export interface CursorAdapter {
  toPos: (e: PointerLike) => PresencePos | null;
  place: (pos: PresencePos, origin: DOMRect) => LayerPoint | null;
}

/** A note, in Source or in Live: the line and the column of the text under the pointer. */
export function textAdapter(getHandle: () => NoteEditorHandle | null): CursorAdapter {
  return {
    toPos(e) {
      const at = getHandle()?.locAt({ x: e.clientX, y: e.clientY });
      return at ? { kind: 'text', line: at.line, col: at.col } : null;
    },
    place(pos, origin) {
      if (pos.kind !== 'text') return null;
      const p = getHandle()?.pointAt({ line: pos.line, col: pos.col });
      return p ? { x: p.x - origin.left, y: p.y - origin.top } : null;
    },
  };
}

/** The part of the Excalidraw state the mapping needs. */
export interface SceneView {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  offsetLeft: number;
  offsetTop: number;
}

/** Scene coordinates of a pointer (the formula Excalidraw itself uses). */
export function sceneOf(view: SceneView, e: PointerLike): { x: number; y: number } {
  return {
    x: (e.clientX - view.offsetLeft) / view.zoom.value - view.scrollX,
    y: (e.clientY - view.offsetTop) / view.zoom.value - view.scrollY,
  };
}

/** The inverse: where a point of the scene is on the screen (viewport pixels). */
export function screenOfScene(view: SceneView, x: number, y: number): { x: number; y: number } {
  return {
    x: (x + view.scrollX) * view.zoom.value + view.offsetLeft,
    y: (y + view.scrollY) * view.zoom.value + view.offsetTop,
  };
}

/** A drawing: points of the scene, mapped through the scroll and the zoom of the Excalidraw view. */
export function sceneAdapter(getApi: () => ExcalidrawImperativeAPI | null): CursorAdapter {
  return {
    toPos(e) {
      const api = getApi();
      if (!api) return null;
      return { kind: 'scene', ...sceneOf(api.getAppState(), e) };
    },
    place(pos, origin) {
      const api = getApi();
      if (!api || pos.kind !== 'scene') return null;
      const p = screenOfScene(api.getAppState(), pos.x, pos.y);
      return { x: p.x - origin.left, y: p.y - origin.top };
    },
  };
}

/** The pan and zoom of a canvas board. */
export interface BoardView {
  x: number;
  y: number;
  k: number;
}

/** A canvas: points of the world (`toWorld` of the board), mapped through its translate and scale. */
export function boardAdapter(
  getView: () => BoardView,
  getBoard: () => HTMLElement | null,
): CursorAdapter {
  return {
    toPos(e) {
      const r = getBoard()?.getBoundingClientRect();
      const v = getView();
      if (!r) return null;
      return {
        kind: 'scene',
        x: (e.clientX - r.left - v.x) / v.k,
        y: (e.clientY - r.top - v.y) / v.k,
      };
    },
    place(pos) {
      if (pos.kind !== 'scene') return null;
      const v = getView();
      return { x: pos.x * v.k + v.x, y: pos.y * v.k + v.y };
    },
  };
}
