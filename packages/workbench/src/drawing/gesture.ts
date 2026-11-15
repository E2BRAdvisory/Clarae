// Whether the user is in the middle of something in the editor. Replacing the scene under a
// gesture (a newer version of the file, a merge) would pull the element out of the user's hand:
// what can wait, waits for the gesture to end. Only the types of Excalidraw are imported here.
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

type Gesture = Pick<
  AppState,
  | 'editingTextElement'
  | 'newElement'
  | 'resizingElement'
  | 'multiElement'
  | 'selectionElement'
  | 'selectedElementsAreBeingDragged'
  | 'isResizing'
  | 'isRotating'
>;

/** Typing in a text, drawing a shape or a line, dragging, resizing, rotating, rubber-banding. */
export function gestureUnderWay(s: Gesture): boolean {
  return !!(
    s.editingTextElement ||
    s.newElement ||
    s.resizingElement ||
    s.multiElement ||
    s.selectionElement ||
    s.selectedElementsAreBeingDragged ||
    s.isResizing ||
    s.isRotating
  );
}

type IdleApi = Pick<ExcalidrawImperativeAPI, 'getAppState' | 'onChange'>;

/**
 * Resolves true as soon as no gesture is under way, false when one still is after `timeoutMs`
 * (the caller gives up: nothing is forced on a user who is still at it).
 */
export function whenIdle(api: IdleApi, timeoutMs: number): Promise<boolean> {
  if (!gestureUnderWay(api.getAppState())) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (idle: boolean): void => {
      clearTimeout(timer);
      off();
      resolve(idle);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    const off = api.onChange((_elements, state) => {
      if (!gestureUnderWay(state)) done(true);
    });
  });
}
