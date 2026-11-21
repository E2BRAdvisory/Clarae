import { describe, expect, it } from 'vitest';
import type { NoteEditorHandle } from '../editor/handle';
import { boardAdapter, screenOfScene, sceneOf, textAdapter, type SceneView } from './adapters';

const origin = (left: number, top: number): DOMRect => new DOMRect(left, top, 800, 600);

describe('the text adapter', () => {
  const handle = {
    locAt: (at: { x: number; y: number }) => (at.x < 0 ? null : { line: 3, col: 7 }),
    pointAt: ({ line, col }: { line: number; col: number }) =>
      line === 99 ? null : { x: 100 + col, y: 50 + line * 10, height: 18 },
  } as unknown as NoteEditorHandle;
  const adapter = textAdapter(() => handle);

  it('sends the line and column under the pointer, never pixels', () => {
    expect(adapter.toPos({ clientX: 120, clientY: 80 })).toEqual({ kind: 'text', line: 3, col: 7 });
    expect(adapter.toPos({ clientX: -1, clientY: 80 })).toBeNull();
  });

  it('draws a position at the place of the text, from the corner of the layer', () => {
    expect(adapter.place({ kind: 'text', line: 2, col: 5 }, origin(10, 20))).toEqual({
      x: 95,
      y: 50,
    });
    expect(adapter.place({ kind: 'text', line: 99, col: 1 }, origin(0, 0))).toBeNull(); // not shown
    expect(adapter.place({ kind: 'scene', x: 1, y: 1 }, origin(0, 0))).toBeNull(); // not a text position
  });

  it('draws nothing while there is no editor', () => {
    const none = textAdapter(() => null);
    expect(none.toPos({ clientX: 1, clientY: 1 })).toBeNull();
    expect(none.place({ kind: 'text', line: 1, col: 1 }, origin(0, 0))).toBeNull();
  });
});

describe('the scene (drawings)', () => {
  const view: SceneView = {
    scrollX: -50,
    scrollY: 30,
    zoom: { value: 2 },
    offsetLeft: 200,
    offsetTop: 100,
  };

  it('maps a pointer to the scene and back, through scroll and zoom', () => {
    const p = sceneOf(view, { clientX: 400, clientY: 300 });
    expect(p).toEqual({ x: 150, y: 70 }); // (400-200)/2 - (-50), (300-100)/2 - 30
    const back = screenOfScene(view, p.x, p.y);
    expect(back).toEqual({ x: 400, y: 300 });
  });

  it('follows the zoom and the scroll: the same scene point is drawn elsewhere', () => {
    const at = screenOfScene(view, 150, 70);
    const zoomed = screenOfScene({ ...view, zoom: { value: 4 } }, 150, 70);
    const scrolled = screenOfScene({ ...view, scrollX: -150 }, 150, 70);
    expect(zoomed.x).toBeGreaterThan(at.x);
    expect(scrolled.x).toBe(at.x - 200);
  });
});

describe('the board (canvas)', () => {
  const board = document.createElement('div');
  board.getBoundingClientRect = () => new DOMRect(40, 60, 800, 600);
  let view = { x: 100, y: -20, k: 0.5 };
  const adapter = boardAdapter(
    () => view,
    () => board,
  );

  it('sends world coordinates (toWorld) and draws them through the translate and scale', () => {
    const pos = adapter.toPos({ clientX: 340, clientY: 140 });
    expect(pos).toEqual({ kind: 'scene', x: 400, y: 200 }); // ((340-40)-100)/0.5, ((140-60)+20)/0.5
    expect(adapter.place(pos!, origin(0, 0))).toEqual({ x: 300, y: 80 });
    view = { x: 0, y: 0, k: 2 };
    expect(adapter.place({ kind: 'scene', x: 10, y: 10 }, origin(0, 0))).toEqual({ x: 20, y: 20 });
    expect(adapter.place({ kind: 'text', line: 1, col: 1 }, origin(0, 0))).toBeNull();
  });
});
