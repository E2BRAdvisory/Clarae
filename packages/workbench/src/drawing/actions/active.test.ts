import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../state/store';
import { allPanes, emptyLayout, openPath, splitPane } from '../../workspace/layout';
import {
  getSceneController,
  registerSceneController,
  subscribeSceneController,
  unregisterSceneController,
  type SceneController,
} from './active';

const registered: SceneController[] = [];
const editor = (drawingPath: string, pane: string | null): SceneController => {
  const c = { drawingPath, paneId: () => pane } as unknown as SceneController;
  registerSceneController(c);
  registered.push(c);
  return c;
};

let left = '';
let right = '';
const focus = (pane: string) => useAppStore.getState().focusPane(pane);

beforeEach(() => {
  // Board.excalidraw in two panes side by side; the split puts the focus on the new one.
  let layout = openPath(emptyLayout(), 'Board.excalidraw', { mode: 'live' });
  left = layout.activePane;
  layout = splitPane(layout, left, 'row', 'live');
  useAppStore.setState({ layout });
  const panes = allPanes(layout.root).map((p) => p.id);
  right = panes.find((id) => id !== left)!;
  expect(panes).toHaveLength(2);
});
afterEach(() => registered.splice(0).forEach(unregisterSceneController));

describe('the editor a command acts on', () => {
  it('is the one of the pane in focus when a drawing is open twice', () => {
    const a = editor('Board.excalidraw', left);
    const b = editor('Board.excalidraw', right);
    focus(right);
    expect(getSceneController()).toBe(b);
    expect(getSceneController('Board.excalidraw')).toBe(b);
    // the focus moves to the pane whose editor registered first
    focus(left);
    expect(getSceneController()).toBe(a);
    expect(getSceneController('Board.excalidraw')).toBe(a);
  });

  it('is the editor of the drawing asked for, wherever the focus is', () => {
    const board = editor('Board.excalidraw', left);
    const other = editor('Other.excalidraw', right);
    focus(left);
    expect(getSceneController('Other.excalidraw')).toBe(other);
    expect(getSceneController('Board.excalidraw')).toBe(board);
    expect(getSceneController('Missing.excalidraw')).toBeNull();
    expect(getSceneController(null)).toBeNull();
  });

  it('is the one that registered last while a note is in focus', () => {
    const a = editor('Board.excalidraw', left);
    const b = editor('Board.excalidraw', right);
    // the pane in focus shows a note now: no editor is in it
    useAppStore.setState({
      layout: openPath(useAppStore.getState().layout, 'Note.md', { mode: 'live' }),
    });
    const withNote = useAppStore.getState().layout.activePane;
    const other = withNote === left ? b : a;
    const here = withNote === left ? a : b;
    unregisterSceneController(here);
    expect(getSceneController()).toBe(other);
    expect(getSceneController('Board.excalidraw')).toBe(other);
  });

  it('passes to the other pane when the editor in focus goes away, and tells who listens', () => {
    const a = editor('Board.excalidraw', left);
    const b = editor('Board.excalidraw', right);
    focus(right);
    const listener = vi.fn();
    const off = subscribeSceneController(listener);
    unregisterSceneController(b);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSceneController('Board.excalidraw')).toBe(a);
    off();
  });
});
